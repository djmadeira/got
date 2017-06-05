'use strict';
const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const PassThrough = require('stream').PassThrough;
const urlLib = require('url');
const querystring = require('querystring');
const createLogger = require('logging').default;
const duplexer3 = require('duplexer3');
const isStream = require('is-stream');
const getStream = require('get-stream');
const timedOut = require('timed-out');
const urlParseLax = require('url-parse-lax');
const lowercaseKeys = require('lowercase-keys');
const decompressResponse = require('decompress-response');
const isRetryAllowed = require('is-retry-allowed');
const Buffer = require('safe-buffer').Buffer;
const isURL = require('isurl');
const isPlainObj = require('is-plain-obj');
const pkg = require('./package');

const getMethodRedirectCodes = new Set([300, 301, 302, 303, 304, 305, 307, 308]);
const allMethodRedirectCodes = new Set([300, 303, 307, 308]);

class CancelError extends Error {
	constructor() {
		super('Promise was canceled');
		this.name = 'CancelError';
	}
}

class PCancelable extends Promise {
	static fn(fn) {
		this.log.info('fn called');
		return function () {
			const args = [].slice.apply(arguments);
			return new PCancelable((onCancel, resolve, reject) => {
				args.unshift(onCancel);
				fn.apply(null, args).then(resolve, reject);
			});
		};
	}

	constructor(executor) {
		super(resolve => {
			console.log('p-cancelable resolve with undefined');
			resolve();
		});

		this.log = createLogger('p-cancelable');

		this._pending = true;
		this._canceled = false;

		this._promise = new Promise((resolve, reject) => {
			this._reject = reject;

			return executor(
				fn => {
					this._cancel = fn;
				},
				val => {
					this._pending = false;
					this.log.info(`resolving with ${typeof val}`);
					resolve(val);
				},
				err => {
					this._pending = false;
					reject(err);
				}
			);
		});
	}

	then() {
		this.log.info('.then called');
		return this._promise.then.apply(this._promise, arguments);
	}

	catch() {
		return this._promise.catch.apply(this._promise, arguments);
	}

	cancel() {
		this.log.info('cancelled!!');
		if (!this._pending || this._canceled) {
			return;
		}

		if (typeof this._cancel === 'function') {
			try {
				this._cancel();
			} catch (err) {
				this._reject(err);
			}
		}

		this._canceled = true;
		this._reject(new CancelError());
	}

	get canceled() {
		return this._canceled;
	}
}

class TimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TimeoutError';
	}
}

const pTimeout = (promise, ms, fallback) => new Promise((resolve, reject) => {
	const log = createLogger('p-timeout');

	if (typeof ms !== 'number' && ms >= 0) {
		throw new TypeError('Expected `ms` to be a positive number');
	}

	const timer = setTimeout(() => {
		log.info('p-timeout timeout', fallback);

		if (typeof fallback === 'function') {
			const res = fallback();
			log.info(`p-timeout resolving with fallback ${res}`);
			resolve(res);
			return;
		}

		const message = typeof fallback === 'string' ? fallback : `Promise timed out after ${ms} milliseconds`;
		const err = fallback instanceof Error ? fallback : new TimeoutError(message);

		log.info('p-timeout about to reject', err);
		reject(err);
	}, ms);

	promise.then(
		val => {
			log.info('p-timeout resolve');
			clearTimeout(timer);
			resolve(val);
		},
		err => {
			log.info('p-timeout reject');
			clearTimeout(timer);
			reject(err);
		}
	);
});

function requestAsEventEmitter(opts) {
	opts = opts || {};

	const ee = new EventEmitter();
	const requestUrl = opts.href || urlLib.resolve(urlLib.format(opts), opts.path);
	const redirects = [];
	let retryCount = 0;
	let redirectUrl;

	const get = opts => {
		if (opts.protocol !== 'http:' && opts.protocol !== 'https:') {
			ee.emit('error', new got.UnsupportedProtocolError(opts));
			return;
		}

		let fn = opts.protocol === 'https:' ? https : http;

		if (opts.useElectronNet && process.versions.electron) {
			const electron = require('electron');
			fn = electron.net || electron.remote.net;
		}

		const req = fn.request(opts, res => {
			const statusCode = res.statusCode;
			console.log('GOT REQUEST RESOLVED', statusCode);

			res.url = redirectUrl || requestUrl;
			res.requestUrl = requestUrl;

			const followRedirect = opts.followRedirect && 'location' in res.headers;
			const redirectGet = followRedirect && getMethodRedirectCodes.has(statusCode);
			const redirectAll = followRedirect && allMethodRedirectCodes.has(statusCode);

			if (redirectAll || (redirectGet && (opts.method === 'GET' || opts.method === 'HEAD'))) {
				res.resume();

				if (statusCode === 303) {
					// Server responded with "see other", indicating that the resource exists at another location,
					// and the client should request it from that location via GET or HEAD.
					opts.method = 'GET';
				}

				if (redirects.length >= 10) {
					ee.emit('error', new got.MaxRedirectsError(statusCode, redirects, opts), null, res);
					return;
				}

				const bufferString = Buffer.from(res.headers.location, 'binary').toString();

				redirectUrl = urlLib.resolve(urlLib.format(opts), bufferString);

				redirects.push(redirectUrl);

				const redirectOpts = Object.assign({}, opts, urlLib.parse(redirectUrl));

				console.log('redirecting', redirectUrl);
				ee.emit('redirect', res, redirectOpts);

				get(redirectOpts);

				return;
			}

			setImmediate(() => {
				let response;
				if (opts.decompress === true &&
					typeof decompressResponse === 'function' &&
					req.method !== 'HEAD') {
					response = decompressResponse(res);
					console.log('DECOMPRESSED RESPONSE');
				} else {
					console.log('RESPONSE REQUIRED NO DECOMPRESSION');
					response = res;
				}

				if (!opts.decompress && ['gzip', 'deflate'].indexOf(res.headers['content-encoding']) !== -1) {
					console.log('I HAVE NO IDEA WHAT THIS CODE DOES');
					opts.encoding = null;
				}

				response.redirectUrls = redirects;

				ee.emit('response', response);
			});
		});

		req.once('error', err => {
			const backoff = opts.retries(++retryCount, err);

			if (backoff) {
				setTimeout(get, backoff, opts);
				return;
			}

			ee.emit('error', new got.RequestError(err, opts));
		});

		if (opts.gotTimeout && (opts.gotTimeout.socket || opts.gotTimeout.connect)) {
			console.log('timed-out IS GETTING IN THE MIX', opts.gotTimeout);
			timedOut(req, opts.gotTimeout);
		}

		setImmediate(() => {
			ee.emit('request', req);
		});
	};

	setImmediate(() => {
		get(opts);
	});
	return ee;
}

function asPromise(opts) {
	const log = createLogger(opts.path);

	const timeoutFn = requestPromise => {
		if (opts.gotTimeout && opts.gotTimeout.request) {
			log.info('USING p-timeout');
			return pTimeout(requestPromise, opts.gotTimeout.request, new got.RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, opts))
				.then(res => {
					log.info('resolves');
					return res;
				});
		}

		log.info('NO TIMEOUT SUPPLIED');
		return requestPromise;
	};

	return timeoutFn(new PCancelable((onCancel, resolve, reject) => {
		const ee = requestAsEventEmitter(opts);
		let cancelOnRequest = false;

		onCancel(() => {
			cancelOnRequest = true;
		});

		ee.on('request', req => {
			if (cancelOnRequest) {
				log.info('REQUEST CANCELLED BEFORE START');
				req.abort();
			}

			onCancel(() => {
				log.info('REQUEST CANCELLED');
				req.abort();
			});

			if (isStream(opts.body)) {
				opts.body.pipe(req);
				opts.body = undefined;
				return;
			}

			req.end(opts.body);
		});

		ee.on('response', res => {
			const stream = opts.encoding === null ? getStream.buffer(res) : getStream(res, opts);

			stream
				.catch(err => reject(new got.ReadError(err, opts)))
				.then(data => {
					if (typeof data === 'string') {
						log.info('STREAM RESOLVED', data);
					} else {
						log.info(`STREAM RESOLVED WITH ${typeof data}`);
					}

					const statusCode = res.statusCode;
					const limitStatusCode = opts.followRedirect ? 299 : 399;

					res.body = data;

					if (opts.json && res.body) {
						try {
							res.body = JSON.parse(res.body);
						} catch (e) {
							if (statusCode >= 200 && statusCode < 300) {
								throw new got.ParseError(e, statusCode, opts, data);
							}
						}
					}

					if (statusCode !== 304 && (statusCode < 200 || statusCode > limitStatusCode)) {
						throw new got.HTTPError(statusCode, res.headers, opts);
					}

					log.info('GOT ABOUT TO RESOLVE', statusCode);
					resolve(res);
				})
				.catch(err => {
					log.info('GOT RESPONSE STREAM FAILED');
					Object.defineProperty(err, 'response', {value: res});
					reject(err);
				});
		});

		ee.on('error', reject);
	}).then(res => {
		log.info(`resolves p-cancelable, ${typeof res}`);
		return res;
	}));
}

function asStream(opts) {
	const input = new PassThrough();
	const output = new PassThrough();
	const proxy = duplexer3(input, output);
	let timeout;

	if (opts.gotTimeout && opts.gotTimeout.request) {
		timeout = setTimeout(() => {
			proxy.emit('error', new got.RequestError({message: 'Request timed out', code: 'ETIMEDOUT'}, opts));
		}, opts.gotTimeout.request);
	}

	if (opts.json) {
		throw new Error('got can not be used as stream when options.json is used');
	}

	if (opts.body) {
		proxy.write = () => {
			throw new Error('got\'s stream is not writable when options.body is used');
		};
	}

	const ee = requestAsEventEmitter(opts);

	ee.on('request', req => {
		proxy.emit('request', req);

		if (isStream(opts.body)) {
			opts.body.pipe(req);
			return;
		}

		if (opts.body) {
			req.end(opts.body);
			return;
		}

		if (opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'PATCH') {
			input.pipe(req);
			return;
		}

		req.end();
	});

	ee.on('response', res => {
		clearTimeout(timeout);

		const statusCode = res.statusCode;

		res.pipe(output);

		if (statusCode !== 304 && (statusCode < 200 || statusCode > 299)) {
			proxy.emit('error', new got.HTTPError(statusCode, res.headers, opts), null, res);
			return;
		}

		proxy.emit('response', res);
	});

	ee.on('redirect', proxy.emit.bind(proxy, 'redirect'));
	ee.on('error', proxy.emit.bind(proxy, 'error'));

	return proxy;
}

function normalizeArguments(url, opts) {
	if (typeof url !== 'string' && typeof url !== 'object') {
		throw new TypeError(`Parameter \`url\` must be a string or object, not ${typeof url}`);
	}

	if (typeof url === 'string') {
		url = url.replace(/^unix:/, 'http://$&');
		url = urlParseLax(url);

		if (url.auth) {
			throw new Error('Basic authentication must be done with auth option');
		}
	}

	if (isURL.lenient(url)) {
		url = urlParseLax(url.href);

		if (url.auth) {
			throw new Error('Basic authentication must be done with auth option');
		}
	}

	opts = Object.assign(
		{
			path: '',
			retries: 2,
			decompress: true,
			useElectronNet: true
		},
		url,
		{
			protocol: url.protocol || 'http:' // Override both null/undefined with default protocol
		},
		opts
	);

	opts.headers = Object.assign({
		'user-agent': `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`,
		'accept-encoding': 'gzip,deflate'
	}, lowercaseKeys(opts.headers));

	const query = opts.query;

	if (query) {
		if (typeof query !== 'string') {
			opts.query = querystring.stringify(query);
		}

		opts.path = `${opts.path.split('?')[0]}?${opts.query}`;
		delete opts.query;
	}

	if (opts.json && opts.headers.accept === undefined) {
		opts.headers.accept = 'application/json';
	}

	const body = opts.body;
	if (body !== null && body !== undefined) {
		const headers = opts.headers;
		if (!isStream(body) && typeof body !== 'string' && !Buffer.isBuffer(body) && !(opts.form || opts.json)) {
			throw new TypeError('options.body must be a ReadableStream, string, Buffer or plain Object');
		}

		if ((opts.form || opts.json) && !isPlainObj(body)) {
			throw new TypeError('options.body must be a plain Object when options.form or options.json is used');
		}

		if (isStream(body) && typeof body.getBoundary === 'function') {
			// Special case for https://github.com/form-data/form-data
			headers['content-type'] = headers['content-type'] || `multipart/form-data; boundary=${body.getBoundary()}`;
		} else if (opts.form && isPlainObj(body)) {
			headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
			opts.body = querystring.stringify(body);
		} else if (opts.json && isPlainObj(body)) {
			headers['content-type'] = headers['content-type'] || 'application/json';
			opts.body = JSON.stringify(body);
		}

		if (headers['content-length'] === undefined && headers['transfer-encoding'] === undefined && !isStream(body)) {
			const length = typeof opts.body === 'string' ? Buffer.byteLength(opts.body) : opts.body.length;
			headers['content-length'] = length;
		}

		opts.method = (opts.method || 'POST').toUpperCase();
	} else {
		opts.method = (opts.method || 'GET').toUpperCase();
	}

	if (opts.hostname === 'unix') {
		const matches = /(.+):(.+)/.exec(opts.path);

		if (matches) {
			opts.socketPath = matches[1];
			opts.path = matches[2];
			opts.host = null;
		}
	}

	if (typeof opts.retries !== 'function') {
		const retries = opts.retries;

		opts.retries = (iter, err) => {
			if (iter > retries || !isRetryAllowed(err)) {
				return 0;
			}

			const noise = Math.random() * 100;

			return ((1 << iter) * 1000) + noise;
		};
	}

	if (opts.followRedirect === undefined) {
		opts.followRedirect = true;
	}

	if (opts.timeout) {
		if (typeof opts.timeout === 'number') {
			opts.gotTimeout = {request: opts.timeout};
		} else {
			opts.gotTimeout = opts.timeout;
		}
		delete opts.timeout;
	}

	console.log('GOT OPTIONS', opts);
	return opts;
}

function got(url, opts) {
	try {
		console.log('GOT REQUESTING AS PROMISE');
		return asPromise(normalizeArguments(url, opts));
	} catch (err) {
		console.log('FAILED TO CONSTRUCT PROMISE');
		return Promise.reject(err);
	}
}

const helpers = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

helpers.forEach(el => {
	got[el] = (url, opts) => got(url, Object.assign({}, opts, {method: el}));
});

got.stream = (url, opts) => asStream(normalizeArguments(url, opts));

for (const el of helpers) {
	got.stream[el] = (url, opts) => got.stream(url, Object.assign({}, opts, {method: el}));
}

class StdError extends Error {
	constructor(message, error, opts) {
		super(message);
		this.name = 'StdError';

		if (error.code !== undefined) {
			this.code = error.code;
		}

		Object.assign(this, {
			host: opts.host,
			hostname: opts.hostname,
			method: opts.method,
			path: opts.path,
			protocol: opts.protocol,
			url: opts.href
		});
	}
}

got.RequestError = class extends StdError {
	constructor(error, opts) {
		super(error.message, error, opts);
		this.name = 'RequestError';
	}
};

got.ReadError = class extends StdError {
	constructor(error, opts) {
		super(error.message, error, opts);
		this.name = 'ReadError';
	}
};

got.ParseError = class extends StdError {
	constructor(error, statusCode, opts, data) {
		super(`${error.message} in "${urlLib.format(opts)}": \n${data.slice(0, 77)}...`, error, opts);
		this.name = 'ParseError';
		this.statusCode = statusCode;
		this.statusMessage = http.STATUS_CODES[this.statusCode];
	}
};

got.HTTPError = class extends StdError {
	constructor(statusCode, headers, opts) {
		const statusMessage = http.STATUS_CODES[statusCode];
		super(`Response code ${statusCode} (${statusMessage})`, {}, opts);
		this.name = 'HTTPError';
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
		this.headers = headers;
	}
};

got.MaxRedirectsError = class extends StdError {
	constructor(statusCode, redirectUrls, opts) {
		super('Redirected 10 times. Aborting.', {}, opts);
		this.name = 'MaxRedirectsError';
		this.statusCode = statusCode;
		this.statusMessage = http.STATUS_CODES[this.statusCode];
		this.redirectUrls = redirectUrls;
	}
};

got.UnsupportedProtocolError = class extends StdError {
	constructor(opts) {
		super(`Unsupported protocol "${opts.protocol}"`, {}, opts);
		this.name = 'UnsupportedProtocolError';
	}
};

module.exports = got;
