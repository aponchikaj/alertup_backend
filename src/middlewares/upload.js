import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import cloudinary from "../services/cloudinary";

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: "uploads",    // Cloudinary folder name
        allowedFormats: ["jpg", "jpeg", "png", "webp"],
    }
});

const upload = multer({ storage });

export default upload;
