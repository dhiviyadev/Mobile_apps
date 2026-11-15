// nexus-ocr: local text recognition with Apple's Vision framework (nothing leaves the Mac).
//   nexus-ocr <image-or-pdf> [max-pages]   → {"pages":[{"page":1,"text":"…"}]}
// Compiled once by NEXUS (swiftc) into <data>/bin/nexus-ocr.
import AppKit
import Foundation
import PDFKit
import Vision

func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { return "" }
    let observations = request.results ?? []
    return observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: nexus-ocr <file> [max-pages]\n".data(using: .utf8)!)
    exit(64)
}
let url = URL(fileURLWithPath: args[1])
let maxPages = args.count >= 3 ? (Int(args[2]) ?? 40) : 40
var pages: [[String: Any]] = []

if url.pathExtension.lowercased() == "pdf" {
    guard let doc = PDFDocument(url: url) else {
        FileHandle.standardError.write("cannot open PDF\n".data(using: .utf8)!)
        exit(66)
    }
    let count = min(doc.pageCount, maxPages)
    for i in 0..<count {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2.0
        let size = NSSize(width: bounds.width * scale, height: bounds.height * scale)
        let thumb = page.thumbnail(of: size, for: .mediaBox)
        var rect = CGRect(origin: .zero, size: thumb.size)
        if let cg = thumb.cgImage(forProposedRect: &rect, context: nil, hints: nil) {
            pages.append(["page": i + 1, "text": recognize(cg)])
        }
    }
} else {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        FileHandle.standardError.write("cannot open image\n".data(using: .utf8)!)
        exit(66)
    }
    pages.append(["page": 1, "text": recognize(cg)])
}

let data = try JSONSerialization.data(withJSONObject: ["pages": pages], options: [])
FileHandle.standardOutput.write(data)
