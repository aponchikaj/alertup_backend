import multer from 'multer';

// Building map uploads now live in S3 (src/services/storage.js), so multer
// keeps the file in memory and the route streams the buffer straight to the
// bucket. Nothing touches the local uploads/ directory anymore.

// The extension decides the S3 key suffix and Content-Type, so anything
// outside this list (.html, .svg) is rejected — these images are publicly
// served and must never be executable content.
const ALLOWED_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

/** S3 key extension for an allowed image mimetype, or null. */
export const imageExtFor = (mimetype) => ALLOWED_EXTENSIONS.get(mimetype) || null;

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
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

export default upload;
