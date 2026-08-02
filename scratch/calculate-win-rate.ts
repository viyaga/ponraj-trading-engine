import fs from 'fs';
import path from 'path';

const logFilePath = path.resolve('c:/Users/manoj/dyad-apps/breakoutex-ai-bot-engine/logs/trades.log');

function parseTradesLog() {
    if (!fs.existsSync(logFilePath)) {
        console.error('trades.log file not found at:', logFilePath);
        return;
    }
    
    console.log('Reading trades.log...');
    const fileContent = fs.readFileSync(logFilePath, 'utf8');
    const lines = fileContent.split('\n');
    
    let totalTradesCount = 0;
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    
    // We want to track transitions and results
    // Lines look like:
    // [StateTransition] Outcome: WIN | Symbol: XRPUSD | Net PnL (Session): 0.01 | Total Fees (Session): 0.00
    // [StateTransition] Outcome: LOSS | Symbol: XRPUSD | Net Debt: -0.01 | Next Level: 2
    
    const transitionRegex = /\[StateTransition\]\s+Outcome:\s+(\w+)\s+\|\s+Symbol:\s+([\w\d]+)(?:\s+\|\s+Net\s+(?:PnL\s+\(Session\)|Debt):\s+([-+]?\d*\.?\d+))?/i;
    
    const tradeOutcomes: any[] = [];
    
    for (const line of lines) {
        const match = line.match(transitionRegex);
        if (match) {
            const outcome = match[1].toUpperCase();
            const symbol = match[2];
            const pnl = match[3] ? parseFloat(match[3]) : 0;
            
            tradeOutcomes.push({ outcome, symbol, pnl, line: line.trim() });
            
            if (outcome === 'WIN') {
                wins++;
            } else if (outcome === 'LOSS') {
                losses++;
            }
            totalPnl += pnl;
        }
    }
    
    console.log(`\n=== parsed trades.log ===`);
    console.log(`Found ${tradeOutcomes.length} state transitions in log.`);
    tradeOutcomes.forEach((t, i) => {
        console.log(`Trade ${i + 1}: ${t.symbol} -> ${t.outcome} (PnL/Debt: ${t.pnl})`);
    });
    
    const settled = wins + losses;
    const winRate = settled > 0 ? (wins / settled) * 100 : 0;
    
    console.log('\n=== Summary ===');
    console.log(`Total Trades processed: ${settled}`);
    console.log(`Wins: ${wins}`);
    console.log(`Losses: ${losses}`);
    console.log(`Win Rate: ${winRate.toFixed(2)}%`);
    console.log(`Net PnL (sum of logged values): ${totalPnl.toFixed(4)}`);
    console.log('================\n');
}

parseTradesLog();
