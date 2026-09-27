// Seed minimal bootstrap data: roles, admin user, one project.
// Usage: node src/db/seed.js [email]   (defaults to admin@practis.local / 'admin1234')
const db = require('./db');
const crypto = require('crypto');

// PBKDF2 is fine for the scaffold ADMIN-ONLY bootstrap account; the full auth
// (Argon2id, invites, lockout) is the SPEC'd TS-01 path and lands with auth work.
function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(pw, salt, 100_000, 32, 'sha256').toString('hex');
  return `pbkdf2$100000$${salt}$${h}`;
}

function main() {
  const email = process.argv[2] || 'admin@practis.local';
  const pw = process.argv[3] || 'admin1234';

  const roles = [
    ['administrator', 'Administrator (global)', 'system'],
    ['project_manager', 'Project Manager', 'project'],
    ['project_controller', 'Project Controller', 'cost'],
    ['cost_controller', 'Cost Controller', 'cost'],
    ['procurement', 'Procurement', 'supply'],
    ['human_capital', 'Human Capital', 'people'],
    ['finance', 'Finance', 'money'],
    ['project_admin', 'Project Admin', 'entry'],
    ['viewer', 'Viewer', 'readonly'],
  ];
  const insRole = db.prepare('INSERT OR IGNORE INTO roles (code, name, domain) VALUES (?, ?, ?)');
  for (const r of roles) insRole.run(...r);

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!existing) {
    db.prepare('INSERT INTO users (email, full_name, password_hash, is_system_admin) VALUES (?, ?, ?, 1)')
      .run(email, 'Ayu Kusuma', hash(pw));
    db.prepare('INSERT INTO user_roles (user_id, role_code) VALUES ((SELECT id FROM users WHERE email = ?), ?)')
      .run(email, 'administrator');
    console.log(`created admin ${email} (pw: ${pw})`);
  } else {
    console.log(`user ${email} exists, skipping`);
  }

  const proj = db.prepare('SELECT id FROM projects WHERE code = ?').get('PRJ-2026');
  if (!proj) {
    db.prepare('INSERT INTO projects (code, name, contract_amount, status, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)')
      .run('PRJ-2026', 'Citarum Bridge', 12_480_000_000, 'active', '2026-01-01', '2027-06-30');
    console.log('created project PRJ-2026 Citarum Bridge (Rp 12.48 mld)');
  } else {
    console.log('project PRJ-2026 exists, skipping');
  }
  db.close();
}

if (require.main === module) {
  main();
}