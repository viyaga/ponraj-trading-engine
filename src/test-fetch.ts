import { Data } from "./services/tradingV2/data";

async function testFetch() {
    try {
        console.log("Starting fetchTradingConfigs test...");
        const configs = await Data.fetchTradingConfigs({ limit: 5, offset: 0 });

        console.log("--------------------------------------------------");
        console.log(`Success! Fetched ${configs.length} configs.`);

        if (configs.length > 0) {
            console.log("Sample Config (Merged):");
            console.log(JSON.stringify(configs[0], null, 2));

            // Validate presence of key fields
            const requiredFields = ['USER_ID', 'API_KEY', 'SYMBOL', 'LEVERAGE', 'BASE_URL'];
            const missing = requiredFields.filter(f => !(f in configs[0]));
            if (missing.length > 0) {
                console.warn("Warning: Missing expected fields:", missing);
            } else {
                console.log("All essential fields present in merged config.");
            }
        }
        console.log("--------------------------------------------------");
    } catch (error) {
        console.error("DEBUG: Test failed with error:");
        console.error(error);
    }
}

testFetch();
