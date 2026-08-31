const MINIMUM_JUDGE_JPEG_BYTES = 50_000;
const MAXIMUM_JUDGE_JPEG_BYTES = 10_000_000;
const MINIMUM_JUDGE_JPEG_WIDTH = 1_200;
const MINIMUM_JUDGE_JPEG_HEIGHT = 675;
const START_OF_FRAME_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

export function inspectJudgeGalleryJpeg(value) {
  const bytes = Buffer.from(value);
  if (
    bytes.length < MINIMUM_JUDGE_JPEG_BYTES ||
    bytes.length > MAXIMUM_JUDGE_JPEG_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return null;
  }
  let offset = 2;
  let dimensions = null;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (
        width < MINIMUM_JUDGE_JPEG_WIDTH ||
        height < MINIMUM_JUDGE_JPEG_HEIGHT
      ) {
        return null;
      }
      dimensions ??= { height, width };
    }
    offset += segmentLength;
  }
  if (!dimensions) return null;
  let decoded;
  try {
    decoded = jpeg.decode(bytes, {
      formatAsRGBA: false,
      maxMemoryUsageInMB: 128,
      maxResolutionInMP: 10,
      tolerantDecoding: false,
      useTArray: true,
    });
  } catch {
    return null;
  }
  if (
    decoded?.width !== dimensions.width ||
    decoded?.height !== dimensions.height ||
    decoded?.data?.length !== dimensions.width * dimensions.height * 3
  ) {
    return null;
  }
  return { bytes: bytes.length, ...dimensions };
}
import jpeg from "jpeg-js";
