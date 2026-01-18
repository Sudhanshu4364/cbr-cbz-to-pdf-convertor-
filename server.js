const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');
const { createExtractorFromData } = require('node-unrar-js');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const archiver = require('archiver');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { 
        fileSize: 500 * 1024 * 1024,
        fieldSize: 50 * 1024 * 1024  
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.cbr' || ext === '.cbz') {
            cb(null, true);
        } else {
            cb(new Error('Only CBR and CBZ files are allowed'));
        }
    }
});

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

// Check if buffer is a valid RAR archive
function isValidRAR(buffer) {
    if (!buffer || buffer.length < 7) return false;
    // RAR magic bytes: 52 61 72 21 1A 07 00 (Rar!\x1A\x07\x00)
    const rarSignature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]);
    return buffer.subarray(0, 7).equals(rarSignature);
}

// 🔧 FIXED: Check if buffer is a valid ZIP archive
function isValidZIP(buffer) {
    if (!buffer || buffer.length < 4) return false;
    // ZIP magic bytes: 50 4B 03 04 (PK\x03\x04)
    return buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
}

async function extractImagesFromRAR(fileBuffer) {
    try {
        const extractor = await createExtractorFromData({
            data: fileBuffer
        });
        
        const list = extractor.getFileList();
        const imageFiles = [];
        
        for (const fileHeader of list.fileHeaders) {
            if (/\.(jpg|jpeg|png|gif|webp)$/i.test(fileHeader.name)) {
                imageFiles.push(fileHeader.name);
            }
        }
        
        return { imageFiles, extractor };
    } catch (error) {
        throw new Error(`Failed to extract RAR archive: ${error.message}`);
    }
}

async function extractImagesFromZIP(fileBuffer) {
    try {
        const zip = new AdmZip(fileBuffer);
        const zipEntries = zip.getEntries();
        
        const imageFiles = [];
        const imageData = {};
        
        for (const entry of zipEntries) {
            if (!entry.isDirectory && /\.(jpg|jpeg|png|gif|webp)$/i.test(entry.name)) {
                imageFiles.push(entry.name);
                imageData[entry.name] = entry.getData();
            }
        }
        
        return { imageFiles, imageData };
    } catch (error) {
        throw new Error(`Failed to extract ZIP archive: ${error.message}`);
    }
}

function naturalSort(a, b) {
    const fileA = a.split(/[\\\/]/).pop().toLowerCase();
    const fileB = b.split(/[\\\/]/).pop().toLowerCase();
    
    const aaParts = fileA.match(/(\d+|\D+)/g) || [];
    const bParts = fileB.match(/(\d+|\D+)/g) || [];
    
    for (let i = 0; i < Math.max(aaParts.length, bParts.length); i++) {
        const partA = aaParts[i] || '';
        const partB = bParts[i] || '';
        
        if (/^\d+$/.test(partA) && /^\d+$/.test(partB)) {
            const numA = parseInt(partA, 10);
            const numB = parseInt(partB, 10);
            if (numA !== numB) return numA - numB;
        } else {
            if (partA !== partB) return partA.localeCompare(partB);
        }
    }
    return 0;
}

// Auto-detect archive type by magic bytes, fallback to extension
async function extractImagesFromArchive(fileBuffer, fileName) {
    let imageFiles, extractor, imageData;
    const ext = path.extname(fileName).toLowerCase();
    
    //Try to detect by magic bytes first
    const isRAR = isValidRAR(fileBuffer);
    const isZIP = isValidZIP(fileBuffer);
    
    // Determine which extractor to use
    let useRAR = false;
    let useZIP = false;
    
    if (isRAR) {
        useRAR = true;
    } else if (isZIP) {
        useZIP = true;
    } else if (ext === '.cbr') {
        useRAR = true;
    } else if (ext === '.cbz') {
        useZIP = true;
    } else {
        throw new Error('Cannot determine archive type. File may be corrupted.');
    }
    
    try {
        if (useRAR) {
            console.log('📦 Detected RAR archive format');
            const result = await extractImagesFromRAR(fileBuffer);
            imageFiles = result.imageFiles;
            extractor = result.extractor;
        } else if (useZIP) {
            console.log('📦 Detected ZIP archive format');
            const result = await extractImagesFromZIP(fileBuffer);
            imageFiles = result.imageFiles;
            imageData = result.imageData;
        } else {
            throw new Error('Unsupported archive format');
        }
    } catch (error) {
        console.error('Archive extraction error:', error.message);
        
        // If detection failed, try the alternative format
        if (useRAR && !isRAR) {
            console.log('⚠️  RAR detection failed, trying ZIP...');
            try {
                const result = await extractImagesFromZIP(fileBuffer);
                imageFiles = result.imageFiles;
                imageData = result.imageData;
                useRAR = false;
                useZIP = true;
            } catch (zipError) {
                throw new Error(`Failed to extract archive: ${error.message}`);
            }
        } else if (useZIP && !isZIP) {
            console.log('⚠️  ZIP detection failed, trying RAR...');
            try {
                const result = await extractImagesFromRAR(fileBuffer);
                imageFiles = result.imageFiles;
                extractor = result.extractor;
                useZIP = false;
                useRAR = true;
            } catch (rarError) {
                throw new Error(`Failed to extract archive: ${error.message}`);
            }
        } else {
            throw error;
        }
    }
    
    // Sort images
    imageFiles.sort(naturalSort);
    
    if (imageFiles.length === 0) {
        throw new Error('No images found in archive file');
    }
    
    console.log(`✅ Found ${imageFiles.length} images`);
    return { imageFiles, extractor, imageData };
}

async function createPDFFromImages(imageFiles, extractor, imageData, bgColor, quality, requiredImageFiles) {
    const extractedImages = [];
    
    if (extractor) {
        const extracted = extractor.extract({
            files: requiredImageFiles
        });
        
        const extractedMap = {};
        for (const file of extracted.files) {
            if (file.extraction) {
                const fullPath = file.fileHeader.name;
                extractedMap[fullPath] = {
                    name: fullPath,
                    data: Buffer.from(file.extraction)
                };
            }
        }
        
        for (const imagePath of requiredImageFiles) {
            if (extractedMap[imagePath]) {
                console.log(`${extractedImages.length + 1}. ${imagePath}`);
                extractedImages.push(extractedMap[imagePath]);
            }
        }
    } else if (imageData) {
        for (const imagePath of requiredImageFiles) {
            if (imageData[imagePath]) {
                console.log(`${extractedImages.length + 1}. ${imagePath}`);
                extractedImages.push({
                    name: imagePath,
                    data: imageData[imagePath]
                });
            }
        }
    }
    
    console.log(`✅ Total images extracted: ${extractedImages.length}\n`);
    
    const pdfDoc = await PDFDocument.create();
    
    for (const imageFile of extractedImages) {
        try {
            let imageDataBuffer = imageFile.data;
            const ext = path.extname(imageFile.name).toLowerCase();
            
            if (ext === '.png') {
                imageDataBuffer = await sharp(imageDataBuffer)
                    .png({ compressionLevel: Math.floor(quality / 20) })
                    .toBuffer();
            } else {
                imageDataBuffer = await sharp(imageDataBuffer)
                    .jpeg({ quality: quality, progressive: true })
                    .toBuffer();
            }
            
            const metadata = await sharp(imageDataBuffer).metadata();
            const imgWidth = metadata.width;
            const imgHeight = metadata.height;
            
            const margin = 0;
            const availableWidth = A4_WIDTH - (2 * margin);
            const availableHeight = A4_HEIGHT - (2 * margin);
            
            let finalWidth = availableWidth;
            let finalHeight = (imgWidth > 0) ? (availableWidth * imgHeight) / imgWidth : availableHeight;
            
            if (finalHeight > availableHeight) {
                finalHeight = availableHeight;
                finalWidth = (imgHeight > 0) ? (availableHeight * imgWidth) / imgHeight : availableWidth;
            }
            
            const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
            
            if (bgColor === 'black') {
                page.drawRectangle({
                    x: 0,
                    y: 0,
                    width: A4_WIDTH,
                    height: A4_HEIGHT,
                    color: rgb(0, 0, 0)
                });
            } else {
                page.drawRectangle({
                    x: 0,
                    y: 0,
                    width: A4_WIDTH,
                    height: A4_HEIGHT,
                    color: rgb(1, 1, 1)
                });
            }
            
            let image;
            if (ext === '.png') {
                image = await pdfDoc.embedPng(imageDataBuffer);
            } else {
                image = await pdfDoc.embedJpg(imageDataBuffer);
            }
            
            const xPos = (A4_WIDTH - finalWidth) / 2;
            const yPos = (A4_HEIGHT - finalHeight) / 2;
            
            page.drawImage(image, {
                x: xPos,
                y: yPos,
                width: finalWidth,
                height: finalHeight
            });
            
        } catch (err) {
            console.error(`Error processing image ${imageFile.name}:`, err.message);
        }
    }
    
    return await pdfDoc.save();
}

// Endpoint to get page count
app.post('/api/get-page-count', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const { imageFiles } = await extractImagesFromArchive(req.file.buffer, req.file.originalname);
        res.json({ totalPages: imageFiles.length });
        
    } catch (error) {
        console.error('Error getting page count:', error);
        res.status(500).json({ error: error.message || 'Failed to get page count' });
    }
});

// Single file conversion endpoint
app.post('/api/convert', upload.single('file'), async (req, res) => {
    let tempDir;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const bgColor = req.body.bgColor || 'white';
        const quality = parseInt(req.body.quality) || 75;
        let pageStart = parseInt(req.body.pageStart) || 1;
        let pageEnd = parseInt(req.body.pageEnd) || undefined;
        
        tempDir = path.join(__dirname, 'temp', Date.now().toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const { imageFiles, extractor, imageData } = await extractImagesFromArchive(req.file.buffer, req.file.originalname);
        
        if (!pageEnd || pageEnd > imageFiles.length) {
            pageEnd = imageFiles.length;
        }
        
        pageStart = Math.max(1, Math.min(pageStart, imageFiles.length));
        pageEnd = Math.max(pageStart, Math.min(pageEnd, imageFiles.length));
        
        const requiredImageFiles = imageFiles.slice(pageStart - 1, pageEnd);
        
        console.log(`📄 Converting pages ${pageStart} to ${pageEnd} (Total: ${requiredImageFiles.length} pages)`);
        
        const pdfBytes = await createPDFFromImages(imageFiles, extractor, imageData, bgColor, quality, requiredImageFiles);
        
        const fileName = req.file.originalname.replace(/\.(cbr|cbz)$/i, '.pdf');
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdfBytes.length);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(Buffer.from(pdfBytes));
        
        console.log(`✅ Conversion completed: ${fileName}\n`);
        
    } catch (error) {
        console.error('Conversion error:', error);
        res.status(500).json({ error: error.message || 'Conversion failed' });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// Batch file conversion endpoint
app.post('/api/batch-convert', upload.array('files', 20), async (req, res) => {
    let tempDir;
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        const bgColor = req.body.bgColor || 'white';
        const quality = parseInt(req.body.quality) || 75;
        
        tempDir = path.join(__dirname, 'temp', Date.now().toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        console.log(`\n📦 Starting batch conversion of ${req.files.length} files...`);
        
        const pdfBuffers = [];
        
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            try {
                console.log(`[${i + 1}/${req.files.length}] Processing: ${file.originalname}`);
                
                const { imageFiles, extractor, imageData } = await extractImagesFromArchive(file.buffer, file.originalname);
                const requiredImageFiles = imageFiles.slice(0, imageFiles.length);
                
                const pdfBytes = await createPDFFromImages(imageFiles, extractor, imageData, bgColor, quality, requiredImageFiles);
                const pdfFileName = file.originalname.replace(/\.(cbr|cbz)$/i, '.pdf');
                
                pdfBuffers.push({
                    name: pdfFileName,
                    data: Buffer.from(pdfBytes)
                });
                
                console.log(`✅ ${pdfFileName} created`);
                
            } catch (error) {
                console.error(`❌ Error converting ${file.originalname}:`, error.message);
            }
        }
        
        if (pdfBuffers.length === 0) {
            return res.status(500).json({ error: 'No files could be converted' });
        }
        
        if (pdfBuffers.length === 1) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Length', pdfBuffers[0].data.length);
            res.setHeader('Content-Disposition', `attachment; filename="${pdfBuffers[0].name}"`);
            res.send(pdfBuffers[0].data);
        } else {
            const archive = archiver('zip', { zlib: { level: 9 } });
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename="converted-pdfs.zip"');
            archive.pipe(res);
            
            for (const pdf of pdfBuffers) {
                archive.append(pdf.data, { name: pdf.name });
            }
            
            await archive.finalize();
            console.log(`\n📦 Batch conversion completed! ${pdfBuffers.length} PDFs packed in ZIP\n`);
        }
        
    } catch (error) {
        console.error('Batch conversion error:', error);
        res.status(500).json({ error: error.message || 'Batch conversion failed' });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// Combination file conversion endpoint (merge all into one PDF)
app.post('/api/combine-convert', upload.array('files', 20), async (req, res) => {
    let tempDir;
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        const bgColor = req.body.bgColor || 'white';
        const quality = parseInt(req.body.quality) || 75;
        
        tempDir = path.join(__dirname, 'temp', Date.now().toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        console.log(`\n🔗 Starting combination of ${req.files.length} files into one PDF...`);
        
        const pdfDoc = await PDFDocument.create();
        
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            try {
                console.log(`[${i + 1}/${req.files.length}] Processing: ${file.originalname}`);
                
                const { imageFiles, extractor, imageData } = await extractImagesFromArchive(file.buffer, file.originalname);
                
                console.log(`  📄 Extracting ${imageFiles.length} pages from ${file.originalname}...`);
                
                const extractedImages = [];
                
                if (extractor) {
                    const extracted = extractor.extract({
                        files: imageFiles
                    });
                    
                    const extractedMap = {};
                    for (const extractedFile of extracted.files) {
                        if (extractedFile.extraction) {
                            const fullPath = extractedFile.fileHeader.name;
                            extractedMap[fullPath] = {
                                name: fullPath,
                                data: Buffer.from(extractedFile.extraction)
                            };
                        }
                    }
                    
                    for (const imagePath of imageFiles) {
                        if (extractedMap[imagePath]) {
                            extractedImages.push(extractedMap[imagePath]);
                        }
                    }
                } else if (imageData) {
                    for (const imagePath of imageFiles) {
                        if (imageData[imagePath]) {
                            extractedImages.push({
                                name: imagePath,
                                data: imageData[imagePath]
                            });
                        }
                    }
                }
                
                // Add each image as a page to the combined PDF
                for (const imageFile of extractedImages) {
                    try {
                        let imageDataBuffer = imageFile.data;
                        const ext = path.extname(imageFile.name).toLowerCase();
                        
                        if (ext === '.png') {
                            imageDataBuffer = await sharp(imageDataBuffer)
                                .png({ compressionLevel: Math.floor(quality / 20) })
                                .toBuffer();
                        } else {
                            imageDataBuffer = await sharp(imageDataBuffer)
                                .jpeg({ quality: quality, progressive: true })
                                .toBuffer();
                        }
                        
                        const metadata = await sharp(imageDataBuffer).metadata();
                        const imgWidth = metadata.width;
                        const imgHeight = metadata.height;
                        
                        const margin = 0;
                        const availableWidth = A4_WIDTH - (2 * margin);
                        const availableHeight = A4_HEIGHT - (2 * margin);
                        
                        let finalWidth = availableWidth;
                        let finalHeight = (imgWidth > 0) ? (availableWidth * imgHeight) / imgWidth : availableHeight;
                        
                        if (finalHeight > availableHeight) {
                            finalHeight = availableHeight;
                            finalWidth = (imgHeight > 0) ? (availableHeight * imgWidth) / imgHeight : availableWidth;
                        }
                        
                        const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
                        
                        if (bgColor === 'black') {
                            page.drawRectangle({
                                x: 0,
                                y: 0,
                                width: A4_WIDTH,
                                height: A4_HEIGHT,
                                color: rgb(0, 0, 0)
                            });
                        } else {
                            page.drawRectangle({
                                x: 0,
                                y: 0,
                                width: A4_WIDTH,
                                height: A4_HEIGHT,
                                color: rgb(1, 1, 1)
                            });
                        }
                        
                        let image;
                        if (ext === '.png') {
                            image = await pdfDoc.embedPng(imageDataBuffer);
                        } else {
                            image = await pdfDoc.embedJpg(imageDataBuffer);
                        }
                        
                        const xPos = (A4_WIDTH - finalWidth) / 2;
                        const yPos = (A4_HEIGHT - finalHeight) / 2;
                        
                        page.drawImage(image, {
                            x: xPos,
                            y: yPos,
                            width: finalWidth,
                            height: finalHeight
                        });
                        
                    } catch (err) {
                        console.error(`  ❌ Error processing image ${imageFile.name}:`, err.message);
                    }
                }
                
                console.log(`  ✅ Added ${extractedImages.length} pages from ${file.originalname}`);
                
            } catch (error) {
                console.error(`❌ Error processing ${file.originalname}:`, error.message);
            }
        }
        
        const pdfBytes = await pdfDoc.save();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdfBytes.length);
        res.setHeader('Content-Disposition', 'attachment; filename="combined-comic.pdf"');
        res.send(Buffer.from(pdfBytes));
        
        console.log(`\n✅ Combination completed! All files merged into one PDF\n`);
        
    } catch (error) {
        console.error('Combination conversion error:', error);
        res.status(500).json({ error: error.message || 'Combination conversion failed' });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// Get pages preview for editor
app.post('/api/get-pages-preview', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const { imageFiles, extractor, imageData } = await extractImagesFromArchive(req.file.buffer, req.file.originalname);
        
        const pages = [];
        
        // Extract first 100 pages for preview
        const previewLimit = Math.min(imageFiles.length, 100);
        const requiredImageFiles = imageFiles.slice(0, previewLimit);
        
        console.log(`🎨 Generating previews for ${previewLimit} pages...`);
        
        if (extractor) {
            const extracted = extractor.extract({
                files: requiredImageFiles
            });
            
            const extractedMap = {};
            for (const file of extracted.files) {
                if (file.extraction) {
                    extractedMap[file.fileHeader.name] = Buffer.from(file.extraction);
                }
            }
            
            for (const imagePath of requiredImageFiles) {
                if (extractedMap[imagePath]) {
                    const thumbnail = await sharp(extractedMap[imagePath])
                        .resize(300, null, { fit: 'inside' })
                        .jpeg({ quality: 60 })
                        .toBuffer();
                    
                    pages.push({
                        imageData: `data:image/jpeg;base64,${thumbnail.toString('base64')}`
                    });
                }
            }
        } else if (imageData) {
            for (const imagePath of requiredImageFiles) {
                if (imageData[imagePath]) {
                    const thumbnail = await sharp(imageData[imagePath])
                        .resize(300, null, { fit: 'inside' })
                        .jpeg({ quality: 60 })
                        .toBuffer();
                    
                    pages.push({
                        imageData: `data:image/jpeg;base64,${thumbnail.toString('base64')}`
                    });
                }
            }
        }
        
        console.log(`✅ Generated ${pages.length} previews`);
        res.json({ pages, totalPages: imageFiles.length });
        
    } catch (error) {
        console.error('Error getting pages preview:', error);
        res.status(500).json({ error: error.message || 'Failed to get pages preview' });
    }
});

// Convert with editor settings (single mode)
app.post('/api/convert-with-editor', upload.single('file'), async (req, res) => {
    let tempDir;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const editorData = JSON.parse(req.body.editorData);
        const quality = 75; // Default quality
        
        tempDir = path.join(__dirname, 'temp', Date.now().toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const { imageFiles, extractor, imageData } = await extractImagesFromArchive(req.file.buffer, req.file.originalname);
        
        // Get only included pages
        const includedPages = editorData.filter(page => page.included);
        const requiredImageFiles = includedPages.map(page => imageFiles[page.index]);
        
        console.log(`\n📝 Converting ${includedPages.length} selected pages from ${imageFiles.length} total pages`);
        
        const extractedImages = [];
        
        if (extractor) {
            const extracted = extractor.extract({
                files: requiredImageFiles
            });
            
            const extractedMap = {};
            for (const file of extracted.files) {
                if (file.extraction) {
                    extractedMap[file.fileHeader.name] = {
                        data: Buffer.from(file.extraction)
                    };
                }
            }
            
            for (const imagePath of requiredImageFiles) {
                if (extractedMap[imagePath]) {
                    extractedImages.push(extractedMap[imagePath]);
                }
            }
        } else if (imageData) {
            for (const imagePath of requiredImageFiles) {
                if (imageData[imagePath]) {
                    extractedImages.push({
                        data: imageData[imagePath]
                    });
                }
            }
        }
        
        // Create PDF with custom settings per page
        const pdfDoc = await PDFDocument.create();
        
        for (let i = 0; i < extractedImages.length; i++) {
            const imageFile = extractedImages[i];
            const pageSettings = includedPages[i];
            
            try {
                let imageDataBuffer = imageFile.data;
                
                // Determine if PNG or JPG based on buffer
                let isPng = false;
                if (imageDataBuffer[0] === 0x89 && imageDataBuffer[1] === 0x50) {
                    isPng = true;
                }
                
                if (isPng) {
                    imageDataBuffer = await sharp(imageDataBuffer)
                        .png({ compressionLevel: Math.floor(quality / 20) })
                        .toBuffer();
                } else {
                    imageDataBuffer = await sharp(imageDataBuffer)
                        .jpeg({ quality: quality, progressive: true })
                        .toBuffer();
                }
                
                const metadata = await sharp(imageDataBuffer).metadata();
                const imgWidth = metadata.width;
                const imgHeight = metadata.height;
                
                const margin = 0;
                const availableWidth = A4_WIDTH - (2 * margin);
                const availableHeight = A4_HEIGHT - (2 * margin);
                
                let finalWidth = availableWidth;
                let finalHeight = (imgWidth > 0) ? (availableWidth * imgHeight) / imgWidth : availableHeight;
                
                if (finalHeight > availableHeight) {
                    finalHeight = availableHeight;
                    finalWidth = (imgHeight > 0) ? (availableHeight * imgWidth) / imgHeight : availableWidth;
                }
                
                const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
                
                // Use custom background color per page
                if (pageSettings.bgColor === 'black') {
                    page.drawRectangle({
                        x: 0,
                        y: 0,
                        width: A4_WIDTH,
                        height: A4_HEIGHT,
                        color: rgb(0, 0, 0)
                    });
                } else {
                    page.drawRectangle({
                        x: 0,
                        y: 0,
                        width: A4_WIDTH,
                        height: A4_HEIGHT,
                        color: rgb(1, 1, 1)
                    });
                }
                
                let image;
                if (isPng) {
                    image = await pdfDoc.embedPng(imageDataBuffer);
                } else {
                    image = await pdfDoc.embedJpg(imageDataBuffer);
                }
                
                const xPos = (A4_WIDTH - finalWidth) / 2;
                const yPos = (A4_HEIGHT - finalHeight) / 2;
                
                page.drawImage(image, {
                    x: xPos,
                    y: yPos,
                    width: finalWidth,
                    height: finalHeight
                });
                
                console.log(`  ✅ Page ${i + 1}/${includedPages.length} - BG: ${pageSettings.bgColor}`);
                
            } catch (err) {
                console.error(`  ❌ Error processing page ${i + 1}:`, err.message);
            }
        }
        
        const pdfBytes = await pdfDoc.save();
        
        const fileName = req.file.originalname.replace(/\.(cbr|cbz)$/i, '.pdf');
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdfBytes.length);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(Buffer.from(pdfBytes));
        
        console.log(`✅ Editor conversion completed: ${fileName}\n`);
        
    } catch (error) {
        console.error('Editor conversion error:', error);
        res.status(500).json({ error: error.message || 'Conversion failed' });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// Combine convert with editor settings (combination mode)
app.post('/api/combine-convert-with-editor', upload.array('files', 20), async (req, res) => {
    let tempDir;
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        const combinationEditorData = req.body.combinationEditorData 
            ? JSON.parse(req.body.combinationEditorData) 
            : {};
        const quality = 75;
        
        tempDir = path.join(__dirname, 'temp', Date.now().toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        console.log(`\n🔗 Starting combination with editor settings for ${req.files.length} files...`);
        
        const pdfDoc = await PDFDocument.create();
        
        for (let fileIdx = 0; fileIdx < req.files.length; fileIdx++) {
            const file = req.files[fileIdx];
            const fileEditorData = combinationEditorData[file.originalname];
            
            if (!fileEditorData) {
                console.log(`⚠️ No editor data for ${file.originalname}, using all pages with default settings...`);
                continue;
            }
            
            try {
                console.log(`[${fileIdx + 1}/${req.files.length}] Processing: ${file.originalname}`);
                
                const { imageFiles, extractor, imageData } = await extractImagesFromArchive(file.buffer, file.originalname);
                
                // Get only included pages, or all pages if no editor data
                let includedPages;
                let requiredImageFiles;

                if (fileEditorData) {
                    includedPages = fileEditorData.filter(page => page.included);
                    requiredImageFiles = includedPages.map(page => imageFiles[page.index]);
                    console.log(`  📄 Processing ${includedPages.length} included pages from ${imageFiles.length} total pages`);
                } else {
                    // Use all pages with default white background
                    includedPages = imageFiles.map((_, index) => ({
                        index: index,
                        included: true,
                        bgColor: 'white'
                    }));
                    requiredImageFiles = imageFiles;
                    console.log(`  📄 Processing all ${imageFiles.length} pages with default settings`);
                }
                
                const extractedImages = [];
                
                if (extractor) {
                    const extracted = extractor.extract({
                        files: requiredImageFiles
                    });
                    
                    const extractedMap = {};
                    for (const extractedFile of extracted.files) {
                        if (extractedFile.extraction) {
                            extractedMap[extractedFile.fileHeader.name] = {
                                data: Buffer.from(extractedFile.extraction)
                            };
                        }
                    }
                    
                    for (const imagePath of requiredImageFiles) {
                        if (extractedMap[imagePath]) {
                            extractedImages.push(extractedMap[imagePath]);
                        }
                    }
                } else if (imageData) {
                    for (const imagePath of requiredImageFiles) {
                        if (imageData[imagePath]) {
                            extractedImages.push({
                                data: imageData[imagePath]
                            });
                        }
                    }
                }
                
                // Add each image to the combined PDF
                for (let i = 0; i < extractedImages.length; i++) {
                    const imageFile = extractedImages[i];
                    const pageSettings = includedPages[i];
                    
                    try {
                        let imageDataBuffer = imageFile.data;
                        
                        let isPng = false;
                        if (imageDataBuffer[0] === 0x89 && imageDataBuffer[1] === 0x50) {
                            isPng = true;
                        }
                        
                        if (isPng) {
                            imageDataBuffer = await sharp(imageDataBuffer)
                                .png({ compressionLevel: Math.floor(quality / 20) })
                                .toBuffer();
                        } else {
                            imageDataBuffer = await sharp(imageDataBuffer)
                                .jpeg({ quality: quality, progressive: true })
                                .toBuffer();
                        }
                        
                        const metadata = await sharp(imageDataBuffer).metadata();
                        const imgWidth = metadata.width;
                        const imgHeight = metadata.height;
                        
                        const margin = 0;
                        const availableWidth = A4_WIDTH - (2 * margin);
                        const availableHeight = A4_HEIGHT - (2 * margin);
                        
                        let finalWidth = availableWidth;
                        let finalHeight = (imgWidth > 0) ? (availableWidth * imgHeight) / imgWidth : availableHeight;
                        
                        if (finalHeight > availableHeight) {
                            finalHeight = availableHeight;
                            finalWidth = (imgHeight > 0) ? (availableHeight * imgWidth) / imgHeight : availableWidth;
                        }
                        
                        const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
                        
                        // Use custom background color per page
                        if (pageSettings.bgColor === 'black') {
                            page.drawRectangle({
                                x: 0,
                                y: 0,
                                width: A4_WIDTH,
                                height: A4_HEIGHT,
                                color: rgb(0, 0, 0)
                            });
                        } else {
                            page.drawRectangle({
                                x: 0,
                                y: 0,
                                width: A4_WIDTH,
                                height: A4_HEIGHT,
                                color: rgb(1, 1, 1)
                            });
                        }
                        
                        let image;
                        if (isPng) {
                            image = await pdfDoc.embedPng(imageDataBuffer);
                        } else {
                            image = await pdfDoc.embedJpg(imageDataBuffer);
                        }
                        
                        const xPos = (A4_WIDTH - finalWidth) / 2;
                        const yPos = (A4_HEIGHT - finalHeight) / 2;
                        
                        page.drawImage(image, {
                            x: xPos,
                            y: yPos,
                            width: finalWidth,
                            height: finalHeight
                        });
                        
                    } catch (err) {
                        console.error(`  ❌ Error processing page:`, err.message);
                    }
                }
                
                console.log(`  ✅ Added ${extractedImages.length} pages from ${file.originalname}`);
                
            } catch (error) {
                console.error(`❌ Error processing ${file.originalname}:`, error.message);
            }
        }
        
        const pdfBytes = await pdfDoc.save();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdfBytes.length);
        res.setHeader('Content-Disposition', 'attachment; filename="combined-comic-edited.pdf"');
        res.send(Buffer.from(pdfBytes));
        
        console.log(`\n✅ Combination with editor completed!\n`);
        
    } catch (error) {
        console.error('Combination editor conversion error:', error);
        res.status(500).json({ error: error.message || 'Combination conversion failed' });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

app.listen(PORT, () => {
    console.log(`🚀 CBR to PDF Converter running at http://localhost:${PORT}`);
    console.log(`📚 Upload CBR/CBZ files to convert them to PDF`);
});
