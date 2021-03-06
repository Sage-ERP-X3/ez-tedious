"use strict";

var generic = require('ez-streams').devices.generic;
var tds = require('tedious');

tracer = {
	debug: null,
	//console.error,
};

/// !doc
/// ## ez-streams wrapper for _tedious_ driver (SQL server)
/// 
/// `var eztedious = require('ez-tedious');`
/// 
module.exports = {
	/// * `reader = eztedious.reader(connection, sql, args)`   
	reader: function(connection, sql, args, opts) {
		opts = opts || {};
		// state
		var error = null,
			callback = null,
			stopped = false,
			done = false,
			paused = false;

		// buffering for rows that have been received but not yet read
		var received = [],
			low = 0,
			high = 2;

		var trace = tracer.debug;

		// handle the pause/resume dance


		function push(record) {
			trace && trace("pushing " + JSON.stringify(record));
			received.push(record);
			if (received.length === high) {
				connection.socket.pause();
				paused = true;
			}
		}

		function shift() {
			if (received.length === low + 1) {
				paused = false;
				connection.socket.resume();
			}
			return received.shift();
		}

		function send(err, result) {
			trace && trace('send(' + (err && err.message) + "," + result + ")");
			var cb = callback;
			callback = null;
			if (cb) {
				if (result) {
					cb(err, result);
				} else {
					done = true;
					cb(null);
				}
			} else {
				error = error || err;
				if (result) {
					// Enqueue the row, il will be dequeued by the generic.reader
					push(result);
				} else {
					done = true;
				}
			}
		}

		function withClose(fn) {
			if (!opts.close) return fn;
			return function(_) {
				try {
					return fn(_);
				} finally {
					if (opts.close) opts.close(_);
					opts.close = null;
				}
			}
		}
		var reader = generic.reader(withClose(function(cb) {
			trace && trace("READ", error, received.length, done);
			if (error) {
				if (request) request.removeAllListeners();
				request = null;
				return cb(error);
			}
			if (received.length) {
				// Dequeue the first available row.
				return cb(null, shift());
			}
			if (done) {
				// Notify the caller that we have nothing more to read. The caller will receive 'undefined'.				
				if (request) request.removeAllListeners();
				request = null;
				return cb();
			}

			// The request is not completed yet, we have to store the callback, it will
			// be invoked later, when a result will be available (see send() method)
			callback = cb;
		}), withClose(function stop(cb) {
			trace && trace("TEDIOUS READER STOP", done);
			if (typeof cb !== 'function') throw new Error("bad callback: " + typeof cb);
			if (done) return cb();
			stopped = true;
			connection.cancel();
			callback = cb;
		}));

		tracer.debug && tracer.debug("reader initialized : " + sql);

		// create the request
		var request = new tds.Request(sql, function(err, rowCount, rows) {
			trace && trace("TDS request complete", err, rowCount, rows);
			// ignore error if we have been stopped
			request.removeAllListeners();
			request = null;
			send(stopped ? null : err);
		});

		// set the parameters
		if (typeof opts.fillParameters !== "function") throw new Error("fillParameters option missing");
		opts.fillParameters(request, args);

		// set up listeners
		request.on('row', function(row) {
			if (stopped) return;
			tracer.debug && tracer.debug("ROW", row);
			send(null, row);
		});

		// execute the query
		connection.execSql(request);

		return reader;
	},


	/// * `writer = eztedious.writer(connection, sql, columnDefs)`
	/// connection : a sql connection (created by require('tedious').Connection(...))
	/// sql : the sql statement (sth like INSERT INTO)
	/// columnDefs : a structure that describes the metadata of each parameter
	///   should look like { "@p0" : xxx, "@p1" : yyy, ...} where xxx and yyy are objects created 
	/// by sqlserver.readTableSchema(...)
	writer: function(connection, sql, opts) {
		if (!connection) throw new Error("connection is missing")
		if (!sql) throw new Error("sql query is missing")
		if (!opts || typeof opts.describeColumns !== "function") throw new Error("opts.describeColumns is missing")
		var done = false;
		var callback;
		var trace;
		var isPreparing = true;
		var pendingParamValues;
		var shouldUnprepare = false;

		trace && trace("writer initialized : " + sql);

		function processError(err) {
			trace && trace('ERROR : ' + JSON.stringify(err));
			connection.removeListener('errorMessage', processError);
			return send(err);
		}

		function send(err) {
			var cb = callback;
			callback = null;
			if (cb) {
				trace && trace('send(' + (err && err.message) + ")");
				cb(err);
			}
		}

		var request = new tds.Request(sql, function(err, rowCount, rows) {
			// Note : this callback is invoked :
			// - when the request is executed
			// - when the request is unprepared
			trace && trace("writer request completed: err=" + err + ", rowCount=" + rowCount);
			if (isPreparing) {
				trace && trace("prepared confirmed");
				// here, the send() method must not be invoked. It will be invoked when the first execute
				// is over (so, on the next call of this callback)
				return;
			}
			if (done) trace && trace("last call : unlock the caller");
			send(err);
		});

		// Now, we can prepare the request
		trace && trace("preparing the request");
		opts.describeColumns(request);

		request.on('prepared', function() {
			trace && trace("request prepared");
			isPreparing = false;
			if (shouldUnprepare) {
				// The writer was closed without having written any row.
				// The write(null) was issued when the request was preparing, the request could not
				// be unprepared because the connection had an invalid state (SentClientRequest). We have 
				// to unprepare it now (once the request is unprepared, the request's callback will be invoked)
				trace && trace("unpreparing the request");
				connection.unprepare(request);
				shouldUnprepare = false;
				return;
			}
			if (pendingParamValues) {
				trace && trace("dequeing values " + JSON.stringify(pendingParamValues));
				connection.execute(request, pendingParamValues);
			}
		});

		// connection.prepare is asynchronous. The connection will have an invalid state until the 'prepared'
		// event is received. Before this event is received, we MUST NOT launch any connection.execute(...)
		connection.prepare(request);

		// Note : the 'error' event is only available on the connection
		// As connections are pooled, we will have to unregister this event before leaving ...
		connection.on('errorMessage', processError);

		//var requestPrepared = false;
		return generic.writer(function(cb, obj) {
			if (done) return;
			callback = cb;
			if ((obj === undefined) && !done) {
				// End of writing operation.
				done = true; // from now, we must not write anything more
				if (isPreparing) {
					// This case occurs when the writer has been created and closed without having written any row
					// The request is being prepared (the 'prepare' event was not fired yet).
					// The request will be unprepared as soon as the 'prepared' event is received					
					shouldUnprepare = true;
					trace && trace("should unprepare");
				} else {
					trace && trace("unpreparing the request");
					connection.unprepare(request);
				}
				connection.removeListener('errorMessage', processError);
				// Note : we must not invoke the send() method here because the connection has an invalid state
				// it's processing the unprepare. When the unprepare will be over, the callback bound to the request
				// will be invoked and then the send() method will be invoked.
				return;
			}
			try {
				var vals = Array.isArray(obj) ? obj : Object.keys(obj).map(function(k, i) {
					return obj[k];
				});

				var paramValues = {};
				vals.forEach(function(value, index) {
					paramValues["p" + index] = value;
				});

				if (isPreparing) {
					// We can't execute the request now, the connection is not in a valid state
					// We have to enqueue the values. The request will be executed as soon as
					// the request will be prepared (see request.on('prepared') for more details)
					trace && trace("waiting for request's prepare : enqueing values " + JSON.stringify(paramValues));
					pendingParamValues = paramValues;
				} else {
					trace && trace("execute values " + JSON.stringify(paramValues));
					connection.execute(request, paramValues);
				}
			} catch (err) {
				trace && trace("ERROR : " + err);
				if (callback) {
					// Do not invoke callback twice
					callback(err);
					callback = null;
				}
			}
		});
	},
};