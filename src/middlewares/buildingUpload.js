import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';

// Create uploads directory if it doesn't exist
const uploadDir = path.join(process.cwd(), 'uploads', 'buildings');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Only these land on disk. The extension decides how express.static labels the
// file, and uploads/ is publicly served, so anything outside this list (.html,
// .svg) would be served back as executable content on the API origin.
const ALLOWED_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

// Configure multer for building uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // The extension comes from our own allowlist, never from originalname —
    // a part named "payload.html" declaring image/png used to be written as
    // .html and then served as text/html.
    const extension = ALLOWED_EXTENSIONS.get(file.mimetype) || '.bin';
    // randomBytes rather than Math.random: these filenames are publicly
    // visible, and leaking PRNG outputs makes the rest of the process's
    // Math.random() stream predictable.
    const uniqueSuffix = `${Date.now()}-${randomBytes(8).toString('hex')}`;
    cb(null, `${file.fieldname}-${uniqueSuffix}${extension}`);
  }
});

const fileFilter = (req, file, cb) => {
  // mimetype is client-supplied, so it is matched against the allowlist rather
  // than merely checked for an "image/" prefix.
  if (ALLOWED_EXTENSIONS.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PNG, JPEG, WebP and GIF image files are allowed'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

export default upload;
