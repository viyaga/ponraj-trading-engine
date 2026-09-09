const { execSync } = require('child_process');

function execSafe(cmd, options = {}) {
  try {
    return execSync(cmd, { stdio: 'inherit', ...options });
  } catch (err) {
    if (options.throwOnError) {
      throw err;
    }
    return null;
  }
}

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

// 1. Compile TypeScript
console.log('Step 1/3: Building TypeScript project (tsc)...');
try {
  execSync('npm run build', { stdio: 'inherit' });
  console.log('Build completed successfully.\n');
} catch (err) {
  console.error('\n❌ Build failed! Not restarting PM2 to keep system safe.');
  process.exit(1);
}

// 2. Kill previous instances cleanly without error
console.log('Step 2/3: Cleaning up any old PM2 processes...');
const targetProcesses = ['ponraj-trading-engine', 'trading-engine'];
for (const proc of targetProcesses) {
  deletePreviousProcess(proc);
}
console.log('Clean-up done.\n');

// 3. Start freshly in PM2
console.log('Step 3/3: Starting fresh PM2 instance with updated environment...');
let started = false;
try {
  execSync('pm2 start dist/server.js --name ponraj-trading-engine --update-env', { stdio: 'inherit' });
  started = true;
} catch {
  try {
    execSync('npx pm2 start dist/server.js --name ponraj-trading-engine --update-env', { stdio: 'inherit' });
    started = true;
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
