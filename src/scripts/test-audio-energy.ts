import { readFile } from 'fs/promises';

async function main() {
  for (const path of ['/tmp/joe.pcm', '/tmp/uh.pcm', '/tmp/test_vad_joe.pcm', '/tmp/test_vad_uh.pcm']) {
    try {
      const raw = await readFile(path);
      const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      let minVal = Infinity, maxVal = -Infinity;
      for (let i = 0; i < pcm16.length; i++) {
        if (pcm16[i] < minVal) minVal = pcm16[i];
        if (pcm16[i] > maxVal) maxVal = pcm16[i];
      }
      console.log(`${path}: samples=${pcm16.length}, range=[${minVal}, ${maxVal}], duration=${(pcm16.length / 16000).toFixed(2)}s`);
    } catch (e) {
      // skip
    }
  }
}

main();
