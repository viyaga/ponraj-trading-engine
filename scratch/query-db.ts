import mongoose from 'mongoose';

async function run() {
  const backendUri = 'mongodb://127.0.0.1:27017/breakoutex-ai-backend';
  console.log('Connecting to Backend DB:', backendUri);
  const connBackend = await mongoose.createConnection(backendUri).asPromise();
  
  const botSchema = new mongoose.Schema({}, { strict: false });
  
  const collectionNames = ['trading-bots', 'trading_bots', 'trade-states', 'tradestates'];
  for (const name of collectionNames) {
    try {
      const Model = connBackend.model(name, botSchema, name);
      const docs = await Model.find({
        $or: [
          { _id: new mongoose.Types.ObjectId('69f4df9a6f50257eb74a6a45') },
          { id: '69f4df9a6f50257eb74a6a45' },
          { _id: '69f4df9a6f50257eb74a6a45' as any }
        ]
      });
      console.log(`Query in backend collection "${name}" returned:`, JSON.stringify(docs, null, 2));
    } catch (e) {
      console.error(`Error querying collection ${name}:`, e);
    }
  }

  // Also query engine DB for 6a19915e724cd3638890b5a3 just in case it exists locally now
  const engineUri = 'mongodb://127.0.0.1:27017/breakoutex-ai-engine';
  const connEngine = await mongoose.createConnection(engineUri).asPromise();
  try {
    const Model = connEngine.model('tradestates', botSchema, 'tradestates');
    const doc = await Model.findById('6a19915e724cd3638890b5a3');
    console.log('Query in engine tradestates for 6a19915e724cd3638890b5a3:', JSON.stringify(doc, null, 2));
  } catch (e) {
    console.error('Error querying engine tradestates:', e);
  }

  await connBackend.close();
  await connEngine.close();
}

run().catch(console.error);
