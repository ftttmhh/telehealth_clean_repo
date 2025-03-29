// This file serves as an entry point for Render
// It requires app.js as a CommonJS module

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Require your app.js file
require('./app.js'); 
