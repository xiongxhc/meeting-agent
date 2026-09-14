import Foundation
import Darwin

public protocol BridgeEvidenceSink: AnyObject {
    func append(_ line: Data) throws
    func close() throws
}

/// Create-new private JSONL, fsynced per record. Directory descriptors and
/// O_NOFOLLOW avoid symlink traversal/replacement races; no path enters errors.
public final class FileEvidenceSink: BridgeEvidenceSink {
    private var fd: Int32 = -1
    private let maxLineBytes: Int
    public init(root: String, filename: String = "control-" + UUID().uuidString + ".jsonl", maxLineBytes: Int = 131_072) throws {
        self.maxLineBytes = maxLineBytes
        guard root.hasPrefix("/"), !filename.isEmpty, !filename.contains("/"), filename != ".", filename != ".." else { throw BridgeProcessError.evidenceUnavailable }
        let parts = root.split(separator: "/").map(String.init)
        guard !parts.isEmpty, !parts.contains(".."), !parts.contains(".") else { throw BridgeProcessError.evidenceUnavailable }
        var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directory >= 0 else { throw BridgeProcessError.evidenceUnavailable }
        defer { Darwin.close(directory) }
        for (index, part) in parts.enumerated() {
            var next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if next < 0, errno == ENOENT, index == parts.count - 1 {
                guard mkdirat(directory, part, 0o700) == 0 else { throw BridgeProcessError.evidenceUnavailable }
                next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            guard next >= 0 else { throw BridgeProcessError.evidenceUnavailable }
            Darwin.close(directory); directory = next
            var gitInfo = stat()
            if fstatat(directory, ".git", &gitInfo, AT_SYMLINK_NOFOLLOW) == 0 { throw BridgeProcessError.evidenceUnavailable }
        }
        var info = stat()
        guard fstat(directory, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw BridgeProcessError.evidenceUnavailable }
        fd = openat(directory, filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0, fsync(directory) == 0 else { if fd >= 0 { Darwin.close(fd); fd = -1 }; throw BridgeProcessError.evidenceUnavailable }
    }
    public func append(_ line: Data) throws {
        guard fd >= 0, line.count <= maxLineBytes, line.last == 10 else { throw BridgeProcessError.evidenceUnavailable }
        try line.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw BridgeProcessError.evidenceUnavailable }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw BridgeProcessError.evidenceUnavailable }
    }
    public func close() throws {
        guard fd >= 0 else { return }
        let old = fd; fd = -1
        let flushed = fsync(old); let closed = Darwin.close(old)
        guard flushed == 0, closed == 0 else { throw BridgeProcessError.evidenceUnavailable }
    }
    deinit { if fd >= 0 { Darwin.close(fd) } }
}
