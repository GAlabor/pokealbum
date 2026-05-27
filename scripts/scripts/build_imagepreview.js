import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const INPUT_DB = './data/pokemon-index.json';
const OUTPUT_DIR = './public/card-images';
const OUTPUT_DB = './data/pokemon-imagepreview.json';

function getPreviewUrl(card) {
  if (!card.image_url) return null;

  const url = String(card.image_url);

  if (url.includes('/preview_')) {
    return url;
  }

  return url.replace(/\/([^/]+)$/, '/preview_$1');
}

async function downloadImage(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Errore download ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function processCard(card) {
  const previewUrl = getPreviewUrl(card);

  if (!previewUrl || !card.id) {
    return null;
  }

  const filename = `${card.id}.webp`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  const buffer = await downloadImage(previewUrl);

  await sharp(buffer)
    .webp({
      quality: 75,
      effort: 6
    })
    .toFile(outputPath);

  return {
    id: card.id,
    name: card.name,
    image: `/card-images/${filename}`
  };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const raw = await fs.readFile(INPUT_DB, 'utf8');
  const cards = JSON.parse(raw);

  const result = [];

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];

    try {
      const imageData = await processCard(card);

      if (imageData) {
        result.push(imageData);
      }

      console.log(`${i + 1}/${cards.length} OK - ${card.name}`);
    } catch (error) {
      console.warn(`${i + 1}/${cards.length} SKIP - ${card.name}: ${error.message}`);
    }
  }

  await fs.writeFile(
    OUTPUT_DB,
    JSON.stringify(result)
  );

  console.log(`Database immagini creato: ${OUTPUT_DB}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
