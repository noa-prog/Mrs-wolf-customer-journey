require('dotenv').config();
const key = process.env.ANTHROPIC_API_KEY || '';
console.log('Key length:', key.length);
console.log('First char code:', key.charCodeAt(0));
console.log('Starts with sk-ant:', key.startsWith('sk-ant'));
console.log('Preview:', key.substring(0, 20) + '...');
