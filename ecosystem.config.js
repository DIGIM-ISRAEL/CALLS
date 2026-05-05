// ecosystem.config.js — PM2 configuration

module.exports = {
    apps: [
        {
            name: 'donation-server',
            script: '/var/webhook-forwarder/donation-server.js',
            cwd: '/var/webhook-forwarder',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '200M',
            env: {
                NODE_ENV: 'production',
                PORT: 3002,
                TZ: 'Asia/Jerusalem'
            },
            log_file: '/var/log/pm2/donation-server.log',
            error_file: '/var/log/pm2/donation-server-error.log',
            out_file: '/var/log/pm2/donation-server-out.log'
        }
    ]
};
