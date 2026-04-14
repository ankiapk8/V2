import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ProgressCallback = (message: string) => void;

const MIN_TEXT_LENGTH = 20;
const MAX_OCR_DIMENSION = 2200;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function copyBuffer(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer.slice(0));
}

async function loadPdf(buffer: ArrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: copyBuffer(buffer) });
  return loadingTask.promise;
}

async function extractEmbeddedText(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string> {
  const pdf = await loadPdf(buffer);
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onProgress?.(`Extracting page ${pageNumber}/${pdf.numPages}…`);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
        .filter(Boolean)
        .join(" ");
      pageTexts.push(pageText);
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }

  return normalizeText(pageTexts.join("\n"));
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not render PDF page for OCR."));
      }
    }, "image/png");
  });
}

async function extractOcrText(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string> {
  const pdf = await loadPdf(buffer);
  const worker = await createWorker("eng");
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onProgress?.(`OCR page ${pageNumber}/${pdf.numPages}…`);
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.max(
        1,
        Math.min(2, MAX_OCR_DIMENSION / Math.max(baseViewport.width, baseViewport.height)),
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Could not prepare OCR canvas.");
      }

      await page.render({ canvasContext: context, viewport }).promise;
      const image = await canvasToBlob(canvas);
      const { data } = await worker.recognize(image);
      pageTexts.push(data.text);
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await worker.terminate();
    await pdf.destroy();
  }

  return normalizeText(pageTexts.join("\n"));
}

export async function extractPdfText(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string> {
  const embeddedText = await extractEmbeddedText(buffer, onProgress);

  if (embeddedText.length > MIN_TEXT_LENGTH) {
    return embeddedText;
  }

  onProgress?.("Starting OCR…");
  const ocrText = await extractOcrText(buffer, onProgress);

  if (ocrText.length > MIN_TEXT_LENGTH) {
    return ocrText;
  }

  throw new Error("No readable text found in this PDF.");
}

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function isTextFile(file: File): boolean {
  return file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");
}