// 仅用于在不支持可捕获 SIGTERM 的平台测试 Node 信号处理路径。
process.on('message', (message) => { if (message === 'shutdown') process.emit('SIGTERM'); });
