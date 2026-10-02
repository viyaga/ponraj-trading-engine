import fs from 'fs';
import path from 'path';

const reportFile = path.join(process.cwd(), 'cache', 'pattern_backtest_report.json');
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));

// Only keep trades where signal != 'NONE'
const signals = report.filter((r: any) => r.signal !== 'NONE');

console.log(`\n================================================================================`);
console.log(`TOTAL SIGNALS DETECTED ACROSS LAST 2 TRADING DAYS: ${signals.length}`);
console.log(`================================================================================\n`);

signals.forEach((s: any, idx: number) => {
    console.log(`${idx + 1}. [${s.dateIST} - ${s.timeIST} IST] ${s.signal} (${s.optionType}) | Pattern: ${s.pattern}`);
    console.log(`   OHLC: O: ₹${s.open.toFixed(1)}, H: ₹${s.high.toFixed(1)}, L: ₹${s.low.toFixed(1)}, C: ₹${s.close.toFixed(1)} | Range: ₹${(s.high - s.low).toFixed(1)}`);
    console.log(`   Wicks: Upper ${s.upperWickRatio}x body, Lower ${s.lowerWickRatio}x body | Body: ₹${s.body.toFixed(1)} (${s.bodyPct.toFixed(1)}%)`);
    console.log(`   Reason: ${s.reasons[0]}`);
    console.log(`--------------------------------------------------------------------------------`);
});
