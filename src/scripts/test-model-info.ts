import * as ort from 'onnxruntime-node';
import * as path from 'path';

async function main() {
  const session = await ort.InferenceSession.create(path.join(process.cwd(), 'models/firered-vad/fireredvad_stream_vad_with_cache.onnx'));
  console.log('Inputs:');
  for (const [name, input] of Object.entries(session.inputMetadata)) {
    const m = input as unknown as { shape: readonly (string | number)[]; type: string };
    console.log(`  ${name}: shape=${JSON.stringify(m.shape)}, type=${m.type}`);
  }
  console.log('Outputs:');
  for (const [name, output] of Object.entries(session.outputMetadata)) {
    const m = output as unknown as { shape: readonly (string | number)[]; type: string };
    console.log(`  ${name}: shape=${JSON.stringify(m.shape)}, type=${m.type}`);
  }
  await session.release();
}

main().catch((err) => { console.error(err); process.exit(1); });
