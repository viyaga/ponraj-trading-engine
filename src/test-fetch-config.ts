import { Data } from "./services/tradingV2/data";

async function testFetch() {
    try {
        console.log("Starting test fetch...");
        const configs = await Data.fetchTradingConfigs({ limit: 10, offset: 0 });

        console.log(`Fetched ${configs.length} configs.`);

        configs.forEach(c => {
            console.log(`--- Config for ${c.SYMBOL} ---`);
            console.log(`ID: ${c.id}`);
            console.log(`USER_ID: ${c.USER_ID}`);
            console.log(`PRODUCT_ID: ${c.PRODUCT_ID}`);
            console.log(`PRICE_DECIMAL_PLACES: ${c.PRICE_DECIMAL_PLACES}`);
            console.log(`LOT_SIZE: ${c.LOT_SIZE}`);
            console.log(`LEVERAGE: ${c.LEVERAGE}`);
            // Verify no extra fields are present in the object (though they might be there hiddenly, 
            // the interface should be clean)
        });

    } catch (err) {
        console.error("Test failed:", err);
    }
}

testFetch();
