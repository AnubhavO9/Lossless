const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CANVAS_FILE = 'canvas.json';
const SONG_DIR = 'Song';
const ALBUM_DIR = 'Album';
const MAX_SIZE_MB = 5;

const LEGACY_ALLOWED_FILES = new Set([
  'Song/12palpal.mp4',
  'Song/13-findingher.mp4',
  'Song/14-themachine.mp4'
]);

function getModifiedFiles() {
  try {
    let diffOutput = '';
    try {
      diffOutput = execSync('git diff --name-only main...HEAD').toString();
    } catch (e) {
      try {
        diffOutput = execSync('git diff --name-only origin/main...HEAD').toString();
      } catch (e2) {
        diffOutput = execSync('git status --porcelain').toString();
        return diffOutput.split('\n')
          .map(line => line.substring(3).trim())
          .filter(Boolean);
      }
    }
    return diffOutput.split('\n').map(f => f.trim()).filter(Boolean);
  } catch (err) {
    console.warn('Warning: Git is not available or main branch not found. Skipping strict sequential checking.');
    return null;
  }
}

function validate() {
  console.log('--- Starting canvas.json validation ---');

  if (!fs.existsSync(CANVAS_FILE)) {
    const errorMsg = `Error: ${CANVAS_FILE} not found!`;
    console.error(errorMsg);
    fs.writeFileSync('validation_report.md', `### ❌ Validation Failed\n\n${errorMsg}`);
    process.exit(1);
  }

  let data;
  try {
    const content = fs.readFileSync(CANVAS_FILE, 'utf8');
    data = JSON.parse(content);
  } catch (err) {
    const errorMsg = `Error Parsing JSON: ${err.message}`;
    console.error(errorMsg);
    fs.writeFileSync('validation_report.md', `### ❌ Validation Failed\n\n**JSON Parse Error:** ${err.message}`);
    process.exit(1);
  }

  if (!data.items || !Array.isArray(data.items)) {
    const errorMsg = `Error: 'items' array missing or invalid in ${CANVAS_FILE}`;
    console.error(errorMsg);
    fs.writeFileSync('validation_report.md', `### ❌ Validation Failed\n\n${errorMsg}`);
    process.exit(1);
  }

  const items = data.items;
  const errors = [];
  const seen = new Set();
  const modifiedFiles = getModifiedFiles();

  items.forEach((item, index) => {
    const { song, artist, url } = item;

    if (!song || !artist || !url) {
      errors.push({ index, song: song || 'N/A', artist: artist || 'N/A', error: 'Missing required fields' });
      return;
    }

    const key = `${song.toLowerCase()}|${artist.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push({ index, song, artist, error: 'Duplicate song/artist entry' });
    } else {
      seen.add(key);
    }

    const urlLower = url.toLowerCase();
    if (!urlLower.endsWith('.m3u8') && !urlLower.endsWith('.mp4')) {
      errors.push({ index, song, artist, error: `Invalid file extension (must be .m3u8 or .mp4)` });
    }

    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const match = pathname.match(/\/(Song|Album)\/(.+)$/i);
      
      if (match) {
        const directory = match[1];
        const filename = match[2];
        const localPath = path.join(directory, filename);
        
        if (!fs.existsSync(localPath)) {
          errors.push({ index, song, artist, error: `Referenced file does not exist: '${localPath}'` });
        } else {
          const normalizedPath = localPath.replace(/\\/g, '/');
          const isNewFile = !modifiedFiles || modifiedFiles.map(f => f.replace(/\\/g, '/')).includes(normalizedPath);
          
          if (isNewFile) {
            const stats = fs.statSync(localPath);
            const fileSizeMB = stats.size / (1024 * 1024);
            if (fileSizeMB > MAX_SIZE_MB) {
              errors.push({ 
                index, 
                song, 
                artist, 
                error: `File size of '${localPath}' is ${fileSizeMB.toFixed(2)}MB. Newly added files must be equal to or less than ${MAX_SIZE_MB}MB.` 
              });
            }
          }
        }
      } else {
        errors.push({ index, song, artist, error: `URL does not follow repository structure (/Song/ or /Album/)` });
      }
    } catch (err) {
      errors.push({ index, song, artist, error: `Invalid URL format: ${err.message}` });
    }
  });

  if (modifiedFiles) {
    const isNewFileInDirectory = (file) => {
      const normalized = file.replace(/\\/g, '/');
      return (normalized.startsWith('Song/') || normalized.startsWith('Album/')) &&
             normalized !== 'Album/for album canvas.txt';
    };

    const newFiles = modifiedFiles.filter(isNewFileInDirectory);

    const baseNumericalNumbers = [];
    const scanDirectoryForBaseNumbers = (dir) => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const relativePath = path.join(dir, file).replace(/\\/g, '/');
        if (newFiles.includes(relativePath)) return;
        
        const match = file.match(/^(\d+)\.(mp4|m3u8)$/i);
        if (match) {
          baseNumericalNumbers.push(parseInt(match[1], 10));
        }
      });
    };

    scanDirectoryForBaseNumbers(SONG_DIR);
    scanDirectoryForBaseNumbers(ALBUM_DIR);

    const maxBaseNumber = baseNumericalNumbers.length > 0 ? Math.max(...baseNumericalNumbers) : 0;
    console.log(`Highest existing base numerical filename: ${maxBaseNumber}`);

    const newNumericalFiles = [];
    newFiles.forEach(file => {
      const filename = path.basename(file);
      const relativePath = file.replace(/\\/g, '/');

      if (LEGACY_ALLOWED_FILES.has(relativePath)) {
        return;
      }

      const match = filename.match(/^(\d+)\.(mp4|m3u8)$/i);
      if (!match) {
        errors.push({
          index: 'N/A',
          song: 'N/A',
          artist: 'N/A',
          error: `Filename '${file}' is not allowed. New files must follow the numerical series format (e.g. '<number>.mp4' or '<number>.m3u8'). Random naming is prohibited.`
        });
        return;
      }

      newNumericalFiles.push({
        path: file,
        number: parseInt(match[1], 10),
        ext: match[2].toLowerCase()
      });
    });

    if (newNumericalFiles.length > 0) {
      newNumericalFiles.sort((a, b) => a.number - b.number);
      
      newNumericalFiles.forEach((file, index) => {
        const expectedNumber = maxBaseNumber + 1 + index;
        if (file.number !== expectedNumber) {
          errors.push({
            index: 'N/A',
            song: 'N/A',
            artist: 'N/A',
            error: `File '${file.path}' is out of sequence. The next expected filename in the series is '${expectedNumber}.${file.ext}' (highest committed is ${maxBaseNumber}). Gaps or random numbers are not allowed.`
          });
        }
      });
    }
  }

  let reportContent = '';
  if (errors.length > 0) {
    console.error('\n--- Validation FAILED! ---');
    reportContent = `### ❌ Validation Failed\n\nFound **${errors.length}** issues in this Pull Request. Please correct them to enable auto-merge:\n\n`;
    reportContent += '| Target / Item Index | Error Description |\n';
    reportContent += '|---|---|\n';
    errors.forEach(err => {
      const identifier = err.index === 'N/A' ? 'System / Naming' : `Index ${err.index} (${err.song} by ${err.artist})`;
      reportContent += `| ${identifier} | ${err.error} |\n`;
      console.error(`- [${identifier}] ${err.error}`);
    });
    
    fs.writeFileSync('validation_report.md', reportContent);
    process.exit(1);
  } else {
    console.log('\n--- Validation PASSED! ---');
    reportContent = `### ✅ Validation Passed!\n\nAll conditions met (file sizes <= 5MB, correct naming series, no duplicates). Auto-merging...`;
    fs.writeFileSync('validation_report.md', reportContent);
    console.log(`Verification completed successfully.`);
  }
}

validate();
