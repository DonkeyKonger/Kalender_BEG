import AppKit

// Repo-native vector artwork: deliberately distinct from the blue live calendar.
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor(calibratedRed: 0.95, green: 0.63, blue: 0.18, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 48, y: 48, width: 928, height: 928), xRadius: 200, yRadius: 200).fill()
NSColor.white.setFill()
NSBezierPath(roundedRect: NSRect(x: 168, y: 185, width: 688, height: 660), xRadius: 58, yRadius: 58).fill()
let navy = NSColor(calibratedRed: 0.08, green: 0.23, blue: 0.42, alpha: 1)
navy.setFill()
NSBezierPath(rect: NSRect(x: 168, y: 650, width: 688, height: 10)).fill()
for x in [290, 670] {
    NSBezierPath(roundedRect: NSRect(x: x, y: 780, width: 60, height: 130), xRadius: 30, yRadius: 30).fill()
}
let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
("BEG" as NSString).draw(in: NSRect(x: 168, y: 675, width: 688, height: 100), withAttributes: [
    .font: NSFont.systemFont(ofSize: 96, weight: .bold), .foregroundColor: navy, .paragraphStyle: paragraph
])
("TEST" as NSString).draw(in: NSRect(x: 168, y: 325, width: 688, height: 230), withAttributes: [
    .font: NSFont.systemFont(ofSize: 180, weight: .heavy), .foregroundColor: navy, .paragraphStyle: paragraph
])
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
