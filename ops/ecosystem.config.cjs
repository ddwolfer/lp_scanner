// pm2 保活 dashboard server：pm2 start ops/ecosystem.config.cjs && pm2 save
module.exports = { apps: [{ name: 'lp-scanner-web', cwd: __dirname + '/..', script: 'pnpm', args: 'serve', env: { PORT: 3000 }, autorestart: true, max_restarts: 10 }] }
