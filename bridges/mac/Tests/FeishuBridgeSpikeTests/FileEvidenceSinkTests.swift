import Foundation
import XCTest
@testable import FeishuBridgeSpike

final class FileEvidenceSinkTests: XCTestCase {
    func testPrivateIncrementalCreationAndSymlinkRefusal() throws {
        let root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let sink = try FileEvidenceSink(root: root.path, filename: "evidence.jsonl", maxLineBytes: 32)
        try sink.append(Data("{\"ok\":true}\n".utf8))
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("evidence.jsonl"), encoding: .utf8), "{\"ok\":true}\n")
        XCTAssertThrowsError(try sink.append(Data(repeating: 65, count: 33)))
        try sink.close()
        XCTAssertThrowsError(try sink.append(Data("{}\n".utf8)))
        XCTAssertThrowsError(try FileEvidenceSink(root: root.path, filename: "evidence.jsonl"))
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("link").path, withDestinationPath: root.path)
        XCTAssertThrowsError(try FileEvidenceSink(root: root.appendingPathComponent("link").path, filename: "other.jsonl"))
        let attrs = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("evidence.jsonl").path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
}
