const { execSync } = require('child_process');

function deletePreviousProcess(name) {
  try {
    execSync(`pm2 delete ${name}`, { stdio: 'ignore' });
    console.log(`   [✓] Stopped previous process: ${name}`);
  } catch {
    try {
      execSync(`npx pm2 delete ${name}`, { stdio: 'ignore' });
      console.log(`   [✓] Stopped previous process: ${name}`);
    } catch {
      // Process was not running - safe to ignore
    }
  }
}

console.log('====================================================');
console.log('🚀 Ponraj Trading Engine - Fresh PM2 Build & Launch');
console.log('====================================================\n');

// 1. Kill previous instances FIRST to free up memory (avoids Linux OOM 'Killed')
console.log('Step 1/3: Stopping previous PM2 processes to free memory...');
const targetProcesses = ['ponraj-trading-engine', 'trading-engine'];
for (const proc of targetProcesses) {
  deletePreviousProcess(proc);
}
console.log('Memory freed.\n');

// 2. Compile TypeScript with low-memory profile
console.log('Step 2/3: Building TypeScript project (tsc with 512MB heap cap)...');
try {
  execSync('node --max-old-space-size=512 ./node_modules/typescript/bin/tsc', { stdio: 'inherit' });
  console.log('Build completed successfully.\n');
} catch (err) {
  console.error('\n❌ Build failed! Check TypeScript errors above.');
  process.exit(1);
}

// 3. Start freshly in PM2
console.log('Step 3/3: Starting fresh PM2 instance with updated environment...');
try {
  execSync('pm2 start dist/server.js --name ponraj-trading-engine --update-env', { stdio: 'inherit' });
} catch {
  try {
    execSync('npx pm2 start dist/server.js --name ponraj-trading-engine --update-env', { stdio: 'inherit' });
  } catch (err) {
    console.error('\n❌ Failed to start PM2 process:', err.message);
    process.exit(1);
  }
}

// Save PM2 state so it restarts after EC2 reboot
try {
  execSync('pm2 save', { stdio: 'ignore' });
} catch {
  try {
    execSync('npx pm2 save', { stdio: 'ignore' });
  } catch {
    // Ignore if pm2 save isn't configured
  }
}

console.log('\n====================================================');
console.log('✅ Fresh trading engine successfully running in PM2!');
console.log('====================================================');
console.log('To view live logs run: pm2 logs ponraj-trading-engine\n');
