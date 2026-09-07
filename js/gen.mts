import { writeFile } from "node:fs/promises";
import { makeMp4 } from "./src/testing/make-mp4.ts";
const { bytes } = makeMp4({ frameCount: 900, gop: 30, samplesPerChunk: 30, width: 640, height: 360 });
await writeFile("../examples/demo/public/sample.mp4", bytes);
console.log("wrote sample.mp4:", (bytes.length/1024).toFixed(1), "KB, 900 frames = 30s");
