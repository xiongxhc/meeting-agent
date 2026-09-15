import Foundation
import CoreFoundation
import Darwin

public struct BridgeProcessConfiguration {
    public struct Audio: Sendable {
        public let captureDisplayId: UInt32
        public let outputDeviceUid: String
    }
    public static func read(path: String, inspection: Bool) throws -> Self {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw BridgeProcessError.invalidInput }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= 65_536 else { throw BridgeProcessError.invalidInput }
        return try decode(readData(fd: fd), inspection: inspection)
    }

    static func readData(fd: Int32, reader: (Int32, UnsafeMutableRawPointer?, Int) -> Int = Darwin.read) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 65_537)
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        return try bytes.withUnsafeMutableBytes { buffer in
            var offset = 0
            while ProcessInfo.processInfo.systemUptime < deadline {
                let count = reader(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count >= 0, count <= buffer.count - offset else { throw BridgeProcessError.invalidInput }
                if count == 0 { return Data(buffer.prefix(offset)) }
                offset += count
                guard offset <= 65_536 else { throw BridgeProcessError.invalidInput }
            }
            throw BridgeProcessError.invalidInput
        }
    }

    public enum Arguments: Equatable { case help, run(path: String, inspection: Bool) }
    public let pid: Int32
    public let bundlePath: String
    public let bundleIdentifier: String
    public let bundleVersion: String
    public let locale: String
    public let evidenceRoot: String
    public let observationInterval: TimeInterval
    public let joinDeadline: TimeInterval
    public let actionDeadline: TimeInterval
    public let axCallTimeout: Float
    public let labels: FeishuUiLabels
    public let custody: BridgeCustodyBinding?
    public let audio: Audio?

    public static func arguments(_ args: [String]) throws -> Arguments {
        if args == ["--help"] { return .help }
        var path: String?; var inspection = false; var index = 0
        while index < args.count {
            switch args[index] {
            case "--config":
                guard path == nil, index + 1 < args.count, args[index + 1].hasPrefix("/") else { throw BridgeProcessError.invalidInput }
                index += 1; path = args[index]
            case "--inspect-ax":
                guard !inspection else { throw BridgeProcessError.invalidInput }; inspection = true
            default: throw BridgeProcessError.invalidInput
            }
            index += 1
        }
        guard let path else { throw BridgeProcessError.invalidInput }
        return .run(path: path, inspection: inspection)
    }

    public static func decode(_ data: Data, inspection: Bool) throws -> Self {
        guard data.count <= 65_536, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw BridgeProcessError.invalidInput }
        let v3 = object["schema"] as? String == "feishu-bridge-config/v3"
        let v2 = object["schema"] as? String == "feishu-bridge-config/v2" || v3
        var required: Set<String> = ["schema", "pid", "bundlePath", "bundleIdentifier", "bundleVersion", "locale", "evidenceRoot", "observationIntervalMs", "joinDeadlineMs", "actionDeadlineMs", "axCallTimeoutMs"]
        if v2 { required.insert("custody") }
        if v3 { required.insert("audio") }
        guard required.isSubset(of: Set(object.keys)), Set(object.keys).isSubset(of: required.union(["selectors"])) else { throw BridgeProcessError.invalidInput }
        func string(_ key: String) throws -> String {
            guard let value = object[key] as? String, !value.isEmpty, value.utf8.count <= 1024, !value.contains("\0") else { throw BridgeProcessError.invalidInput }; return value
        }
        func integer(_ key: String, _ range: ClosedRange<Int>) throws -> Int {
            guard let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
                  value.doubleValue == Double(value.intValue), range.contains(value.intValue) else { throw BridgeProcessError.invalidInput }; return value.intValue
        }
        let schema = try string("schema")
        guard v2 || schema == "feishu-bridge-config/v1", !(v2 && inspection) else { throw BridgeProcessError.invalidInput }
        let custody: BridgeCustodyBinding?
        if v2 {
            guard let raw = object["custody"] as? [String: Any] else { throw BridgeProcessError.invalidInput }
            custody = try BridgeCustodyBinding(object: raw)
        } else { custody = nil }
        let audio: Audio?
        if v3 {
            guard let raw = object["audio"] as? [String: Any], Set(raw.keys) == ["captureDisplayId", "outputDeviceUid"],
                  let display = raw["captureDisplayId"] as? NSNumber, CFGetTypeID(display) != CFBooleanGetTypeID(),
                  display.doubleValue >= 1, display.doubleValue <= Double(UInt32.max), display.doubleValue == Double(display.uint32Value),
                  let uid = raw["outputDeviceUid"] as? String, !uid.isEmpty, uid.utf8.count <= 512, !uid.contains("\0") else { throw BridgeProcessError.invalidInput }
            audio = Audio(captureDisplayId: display.uint32Value, outputDeviceUid: uid)
        } else { audio = nil }
        let path = try string("bundlePath"), root = try string("evidenceRoot"), build = try string("bundleVersion"), locale = try string("locale")
        guard path.hasPrefix("/"), path.hasSuffix(".app"), root.hasPrefix("/"), root != "/" else { throw BridgeProcessError.invalidInput }
        var labels = FeishuUiLabels.bundled
        if let selectors = object["selectors"] as? [String: Any] {
            guard Set(selectors.keys) == ["build", "locale", "measured", "identifiers", "titles"],
                  selectors["build"] as? String == build, selectors["locale"] as? String == locale,
                  let measured = selectors["measured"] as? NSNumber, CFGetTypeID(measured) == CFBooleanGetTypeID(), measured.boolValue,
                  let ids = selectors["identifiers"] as? [String: String], let titles = selectors["titles"] as? [String: [String]] else { throw BridgeProcessError.invalidInput }
            let placeholders = try JSONSerialization.jsonObject(with: JSONEncoder().encode(FeishuUiLabels.bundled.identifiers)) as! [String: String]
            guard Set(ids.keys) == Set(placeholders.keys), ids.values.allSatisfy({ $0.utf8.count <= 512 && !$0.contains("\0") }),
                  !ids.values.contains(where: { !$0.isEmpty && placeholders.values.contains($0) }),
                  ["joinMeetingNumberField", "joinButton", "meetingWindow", "meetingNumberLabel", "leaveButton"].allSatisfy({ !(ids[$0] ?? "").isEmpty }),
                  Set(titles.keys).isSubset(of: Set(ids.values.filter { !$0.isEmpty })),
                  titles.values.allSatisfy({ $0.count <= 4 && $0.allSatisfy { !$0.isEmpty && $0.utf8.count <= 512 && !$0.contains("\0") } }) else { throw BridgeProcessError.invalidInput }
            let nonempty = ids.values.filter { !$0.isEmpty }
            guard Set(nonempty).count == nonempty.count else { throw BridgeProcessError.invalidInput }
            labels = FeishuUiLabels(identifiers: try JSONDecoder().decode(FeishuUiLabels.Identifiers.self, from: JSONSerialization.data(withJSONObject: ids)), titlesByIdentifier: titles)
        } else if !inspection || object["selectors"] != nil { throw BridgeProcessError.invalidInput }
        return Self(pid: Int32(try integer("pid", 1...Int(Int32.max))), bundlePath: path,
                    bundleIdentifier: try string("bundleIdentifier"), bundleVersion: build, locale: locale, evidenceRoot: root,
                    observationInterval: Double(try integer("observationIntervalMs", 50...5000)) / 1000,
                    joinDeadline: Double(try integer("joinDeadlineMs", 100...120_000)) / 1000,
                    actionDeadline: Double(try integer("actionDeadlineMs", 100...10_000)) / 1000,
                    axCallTimeout: Float(try integer("axCallTimeoutMs", 10...250)) / 1000, labels: labels, custody: custody, audio: audio)
    }
}
