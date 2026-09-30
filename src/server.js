const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const layouts = require('express-ejs-layouts');

const app = express();
const PORT = process.env.PORT || 3003;

// migrate before serving (idempotent, fast when current)
require('./db/migrate');
require('./db/seed');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(layouts);
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(require('./lib/csrf').csrf); // must sit after cookies + body parsing, before routes
app.use(express.static(path.join(__dirname, '..', 'assets')));

// Resolve the signed-in user + sidebar locals (user name, role, initials, admin
// flag) on every request, so every page — including 403/404 — renders correctly.
app.use(require('./middleware/auth').attachUser);

app.use(require('./routes/auth'));
app.use(require('./routes/admin'));
app.use(require('./routes/api'));
app.use(require('./routes/app'));

// 404 + error handler
app.use((req, res) => res.status(404).render('404', { layout: 'layout-app', title: 'Not found', subtitle: '' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => console.log(`PRACTIS on http://localhost:${PORT}`));