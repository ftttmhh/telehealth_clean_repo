// This file serves as a simple entry point for Render
// It executes app.js as a separate process

const { spawn } = require('child_process');

console.log('Starting app.js via child process...');
const child = spawn('node', ['app.js'], { stdio: 'inherit' });

child.on('close', (code) => {
  console.log(`Child process exited with code ${code}`);
  process.exit(code);
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
}); 
