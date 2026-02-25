const fs = require('fs');
const path = require('path');

/**
 * Format date to DD.MM.YY
 */
function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  return `${day}.${month}.${year}`;
}

/**
 * Get current week folder name (format: "30.12.24 – 05.01.25")
 */
function getCurrentWeekFolder() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const startOfWeek = new Date(now);
  
  // Start of week - Monday (day = 1)
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  startOfWeek.setDate(now.getDate() - diff);
  
  // End of week - Sunday
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  
  return `${formatDate(startOfWeek)} – ${formatDate(endOfWeek)}`;
}

/**
 * Get week key for event counters (format: "2024-52")
 */
function getWeekKey() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now - start) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.ceil((days + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-${weekNumber}`;
}

/**
 * Check if current time is night (00:00 - 09:00 MSK)
 */
function isNightTime() {
  const now = new Date();
  const moscowOffset = 3; // UTC+3
  const moscowHours = (now.getUTCHours() + moscowOffset) % 24;
  return moscowHours >= 0 && moscowHours < 9;
}

/**
 * Generate unique filename
 */
function generateFileName(prefix = 'photo') {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `${prefix}_${timestamp}_${random}.jpg`;
}

/**
 * Extract event numbers from filenames
 */
function extractEventNumbers(filenames) {
  const numbers = [];
  const pattern = /^(\d+)-[12]\.(jpg|jpeg|png|gif)$/i;
  
  for (const filename of filenames) {
    const match = pattern.exec(filename);
    if (match) {
      numbers.push(parseInt(match[1], 10));
    }
  }
  
  return [...new Set(numbers)]; // Remove duplicates
}

/**
 * Safe file deletion
 */
async function safeDeleteFile(filePath) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) {
      resolve(true);
      return;
    }
    
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error('Error deleting file:', err);
        resolve(false);
      } else {
        console.log(`File deleted: ${filePath}`);
        resolve(true);
      }
    });
  });
}

/**
 * Ensure directory exists
 */
function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Parse command arguments from message text
 */
function parseCommandArgs(text, commandName) {
  const parts = text.split(' ');
  if (parts[0] !== `/${commandName}`) return null;
  return parts.slice(1);
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
  formatDate,
  getCurrentWeekFolder,
  getWeekKey,
  isNightTime,
  generateFileName,
  extractEventNumbers,
  safeDeleteFile,
  ensureDirectory,
  parseCommandArgs,
  formatBytes
};
