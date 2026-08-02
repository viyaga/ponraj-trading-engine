import dns from 'dns';
import { promisify } from 'util';

const resolveSrv = promisify(dns.resolveSrv);
const resolveTxt = promisify(dns.resolveTxt);

async function checkDns() {
    const srvRecord = '_mongodb._tcp.cluster0.opjbbul.mongodb.net';
    console.log(`Checking SRV record for: ${srvRecord}`);
    
    try {
        const addresses = await resolveSrv(srvRecord);
        console.log('SRV Records found:', JSON.stringify(addresses, null, 2));
    } catch (err) {
        console.error('SRV Resolution failed:', err);
    }

    try {
        const txt = await resolveTxt('cluster0.opjbbul.mongodb.net');
        console.log('TXT Records found:', txt);
    } catch (err) {
        console.error('TXT Resolution failed:', err);
    }
}

checkDns();
