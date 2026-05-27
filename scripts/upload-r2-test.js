import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

async function main() {
  const content = Buffer.from('TEST POKEALBUM');

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: 'test/test.txt',
    Body: content,
    ContentType: 'text/plain'
  });

  await client.send(command);

  console.log('Upload completato');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
