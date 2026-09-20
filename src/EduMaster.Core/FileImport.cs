using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;
namespace EduMaster.Core;

public sealed record ImportedSource(string Name, string MimeType, string Hash, string StoredName, long Length)
{
    public bool IsAttachment => MimeType is "application/pdf" or "image/png" or "image/jpeg";
}
public static class FileImport
{
    public const int MaxBytes = 10 * 1024 * 1024;
    public static async Task<ProblemDraft> ImportAsync(string path, string directory, CancellationToken token = default)
    {
        var length = new FileInfo(path).Length;
        if (length is <= 0 or > MaxBytes) throw new ArgumentException("파일은 비어 있지 않은 10MB 이하 자료를 선택해 주세요.");
        var bytes = await ReadLimitedAsync(File.OpenRead(path), MaxBytes, token);
        var extension = Path.GetExtension(path).ToLowerInvariant(); string mime; string body = "";
        switch (extension)
        {
            case ".txt": mime = "text/plain"; body = DecodeText(bytes); break;
            case ".docx":
                mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                using (var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read))
                {
                    var entry = zip.GetEntry("word/document.xml") ?? throw new ArgumentException("DOCX 본문을 찾지 못했습니다.");
                    if (entry.Length > 4 * 1024 * 1024) throw new ArgumentException("DOCX 본문이 너무 큽니다. 문제 부분만 별도 파일로 저장해 주세요.");
                    var xml = await ReadLimitedAsync(entry.Open(), 4 * 1024 * 1024, token);
                    using var reader = XmlReader.Create(new MemoryStream(xml), new() { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
                    var document = XDocument.Load(reader); XNamespace w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
                    if (document.Descendants().Any(e => e.Name.LocalName is "oMath" or "oMathPara" or "drawing" or "pict"))
                        throw new ArgumentException("수식·그림이 있는 DOCX입니다. 내용을 빠뜨리지 않도록 Word에서 PDF로 저장한 뒤 넣어 주세요.");
                    body = string.Join("\n", document.Descendants(w + "p").Select(p => string.Concat(p.Descendants(w + "t").Select(t => t.Value)))).Trim();
                }
                break;
            case ".pdf": mime = "application/pdf";
                if (!bytes.AsSpan().StartsWith("%PDF-"u8)) throw new ArgumentException("정상적인 PDF를 선택해 주세요."); break;
            case ".png": mime = "image/png";
                if (!bytes.AsSpan().StartsWith(new byte[] {137,80,78,71,13,10,26,10})) throw new ArgumentException("정상적인 PNG를 선택해 주세요."); break;
            case ".jpg": case ".jpeg": mime = "image/jpeg";
                if (!bytes.AsSpan().StartsWith(new byte[] {255,216,255})) throw new ArgumentException("정상적인 JPG를 선택해 주세요."); break;
            default: throw new ArgumentException("PDF·PNG·JPG·TXT·DOCX 파일을 지원합니다. HWP는 PDF로 저장해 주세요.");
        }
        if (mime is "text/plain" or "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        {
            if (string.IsNullOrWhiteSpace(body)) throw new ArgumentException("읽을 수 있는 본문이 없습니다. 사진·수식만 있는 DOCX는 PDF로 저장해 주세요.");
            if (body.Length > 12000) throw new ArgumentException("본문은 12,000자까지 지원합니다. 문제 부분만 따로 저장해 주세요.");
        }
        var hash = Convert.ToHexString(SHA256.HashData(bytes)); var name = hash + extension;
        var imports = Path.Combine(directory, "imports"); Directory.CreateDirectory(imports);
        var stored = Path.Combine(imports, name); var temporary = stored + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { await File.WriteAllBytesAsync(temporary, bytes, token); File.Move(temporary, stored, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        var title = Path.GetFileNameWithoutExtension(path);
        return new() { Title = title[..Math.Min(title.Length, 200)], Body = body,
            Source = new(Path.GetFileName(path), mime, hash, name, bytes.Length) };
    }
    public static string SourcePath(ImportedSource source, string directory)
    {
        var extension = Path.GetExtension(source.StoredName)?.ToLowerInvariant();
        var expectedMime = extension switch { ".pdf" => "application/pdf", ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".txt" => "text/plain", ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document", _ => "" };
        if (expectedMime == "" || expectedMime != source.MimeType || source.Hash is null || source.Hash.Length != 64 || source.Hash.Any(c => !Uri.IsHexDigit(c)) ||
            Path.GetFileName(source.StoredName) != source.StoredName || Path.GetFileNameWithoutExtension(source.StoredName) != source.Hash)
            throw new InvalidDataException("저장된 파일 정보가 올바르지 않습니다. 파일을 다시 선택해 주세요.");
        return Path.Combine(directory, "imports", source.StoredName);
    }
    public static async Task<byte[]> ReadSourceAsync(ImportedSource source, string directory, CancellationToken token = default)
    {
        var bytes = await ReadLimitedAsync(File.OpenRead(SourcePath(source, directory)), MaxBytes, token);
        if (bytes.Length != source.Length || Convert.ToHexString(SHA256.HashData(bytes)) != source.Hash)
            throw new InvalidDataException("보관된 원본이 변경되었습니다. 파일을 다시 선택해 주세요.");
        return bytes;
    }
    internal static async Task<byte[]> ReadLimitedAsync(Stream stream, int maximum, CancellationToken token)
    {
        using (stream) using (var output = new MemoryStream())
        {
            var buffer = new byte[81920]; int count;
            while ((count = await stream.ReadAsync(buffer, token)) > 0)
            { if (output.Length + count > maximum) throw new ArgumentException("자료 크기가 허용 범위를 넘었습니다."); await output.WriteAsync(buffer.AsMemory(0, count), token); }
            return output.ToArray();
        }
    }
    private static string DecodeText(byte[] bytes)
    {
        try
        {
            var text = bytes.AsSpan().StartsWith(new byte[] {255,254}) ? new UnicodeEncoding(false, true, true).GetString(bytes, 2, bytes.Length - 2)
                : bytes.AsSpan().StartsWith(new byte[] {254,255}) ? new UnicodeEncoding(true, true, true).GetString(bytes, 2, bytes.Length - 2)
                : new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF');
            if (text.Any(c => char.IsControl(c) && c is not '\r' and not '\n' and not '\t')) throw new ArgumentException("TXT에 읽을 수 없는 문자가 있습니다.");
            return text.Trim();
        }
        catch (DecoderFallbackException) { throw new ArgumentException("TXT를 UTF-8 또는 UTF-16으로 저장한 뒤 다시 선택해 주세요."); }
    }
}
