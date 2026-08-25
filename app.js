var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var session = require('express-session');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var viewHelpers = require('./utils/viewHelpers');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Formatting helpers available in every Pug template (e.g. formatTime12h).
Object.assign(app.locals, viewHelpers);

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(session({
  secret: 'stms-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // Always log server-side so a bad request is visible during grading/demo,
  // instead of silently failing.
  if (!err.status || err.status >= 500) {
    console.error(err);
  }
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

// Defense-in-depth: a route handler that forgets a try/catch around a
// rejected promise should never take the whole server down for every
// other student/driver/admin using it at the same time. Log it and keep
// the process alive; the single request that triggered it will simply
// time out instead of crashing everyone else's session.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Database initialization (creating the schema and seeding demo data on
// first run) is awaited once in bin/www, before the HTTP server starts
// listening - see the comment there for why this matters for MySQL.

module.exports = app;
