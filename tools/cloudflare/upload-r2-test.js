import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const TEST_IMAGE =
  'https://cardtrader.com/uploads/blueprints/image/273488/show_zapdos-cosmos-holo-15-62-wotc-employees-only-1999-wizards-theme-deck-blisters-exclusives.jpg';

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

async function main() {
  console.log('Download immagine...');

  const response = await fetch(TEST_IMAGE);

  if (!response.ok) {
    throw new Error(`Errore download: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const inputBuffer = Buffer.from(arrayBuffer);

  console.log('Conversione WEBP...');

  const webpBuffer = await sharp(inputBuffer)
    .webp({
      quality: 72
    })
    .toBuffer();

  console.log(`WEBP size: ${webpBuffer.length} bytes`);

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: 'test/zapdos.webp',
    Body: webpBuffer,
    ContentType: 'image/webp'
  });

  console.log('Upload R2...');

  await client.send(command);

  console.log('Upload completato');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
