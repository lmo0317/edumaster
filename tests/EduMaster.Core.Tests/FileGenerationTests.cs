using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using EduMaster.Core;
namespace EduMaster.Core.Tests;

public class FileGenerationTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "EduMaster-file-tests-" + Guid.NewGuid());
    public FileGenerationTests() => Directory.CreateDirectory(_directory);
    public void Dispose() => Directory.Delete(_directory, true);
    private async Task<ProblemDraft> ImportText(string text = "탄산칼슘 10 g을 완전히 분해한다. CaCO₃ → CaO + CO₂, CaCO₃ = 100 g/mol일 때 발생하는 CO₂의 몰수는?")
    { var file = Path.Combine(_directory, "내문제.txt"); await File.WriteAllTextAsync(file, text); return await FileImport.ImportAsync(file, _directory); }
    private static Dictionary<string, object> Variant(ProblemDraft draft) => new()
    {
        ["status"] = "ready", ["message"] = "", ["sourceProblem"] = draft.Body, ["sourceLocation"] = "문항 1",
        ["title"] = "탄산칼슘 열분해", ["body"] = "탄산칼슘 20 g을 완전히 분해한다. CaCO₃ → CaO + CO₂, CaCO₃ = 100 g/mol일 때 발생하는 CO₂의 몰수는?",
        ["choices"] = new[] { "0.05 mol", "0.1 mol", "0.2 mol", "0.4 mol", "1 mol" }, ["answerIndex"] = 2,
        ["explanation"] = "탄산칼슘 20/100 = 0.2 mol이며 반응 계수비 1:1에 따라 CO₂는 0.2 mol 발생한다.",
        ["steps"] = new[] { "몰질량 확인", "20/100 = 0.2 mol", "계수비 1:1 적용" }, ["changeSummary"] = "CaCO₃ 10 g → 20 g"
    };
    private static byte[] Envelope(object variant) => JsonSerializer.SerializeToUtf8Bytes(new
    { status = "completed", model = GeminiGenerator.DefaultModel, steps = new[] { new { type = "model_output", content = new[] { new { type = "text", text = JsonSerializer.Serialize(variant) } } } }, usage = new { total_tokens = 321 } });
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        internal int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { Calls++; return send(request, token); }
    }
    [Fact] public async Task OwnFileWithoutAnswerRestoresAndUsesSnapshot()
    {
        var draft = await ImportText(); draft.Validate(); Assert.Empty(draft.Answer);
        await new StateStore(_directory).SaveAsync(new(draft, null, 0, DateTimeOffset.Now));
        var restored = (await new StateStore(_directory).LoadAsync())!.Draft;
        Assert.Equal(draft.Body, restored.Body); Assert.Equal(draft.Source, restored.Source);
        await File.WriteAllTextAsync(Path.Combine(_directory, "내문제.txt"), "원본을 나중에 수정");
        Assert.Equal(draft.Body, Encoding.UTF8.GetString(await FileImport.ReadSourceAsync(restored.Source!, _directory)));
        await File.WriteAllTextAsync(FileImport.SourcePath(restored.Source!, _directory), "손상");
        await Assert.ThrowsAsync<InvalidDataException>(() => FileImport.ReadSourceAsync(restored.Source!, _directory));
    }
    [Fact] public async Task ActualRequestContainsOwnEditedProblemAndNoKeyInBodyOrUrl()
    {
        var draft = (await ImportText()) with { Body = "물 18 g의 몰수는? H₂O의 몰질량은 18 g/mol이다." };
        var variant = Variant(draft); variant["body"] = "물 36 g의 몰수는? H₂O의 몰질량은 18 g/mol이다.";
        using var handler = new Handler(async (request, token) =>
        {
            Assert.Equal("https://generativelanguage.googleapis.com/v1beta/interactions", request.RequestUri!.ToString());
            Assert.Equal("test-secret", request.Headers.GetValues("x-goog-api-key").Single());
            using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.False(json.RootElement.GetProperty("store").GetBoolean());
            Assert.Equal(GeminiGenerator.DefaultModel, json.RootElement.GetProperty("model").GetString());
            var text = json.RootElement.GetProperty("input")[0].GetProperty("text").GetString()!;
            using var input = JsonDocument.Parse(text); Assert.Equal(draft.Body, input.RootElement.GetProperty("body").GetString());
            Assert.DoesNotContain("test-secret", text); Assert.True(json.RootElement.TryGetProperty("response_format", out _));
            return new(HttpStatusCode.OK) { Content = new ByteArrayContent(Envelope(variant)) };
        });
        using var http = new HttpClient(handler); var result = await new GeminiGenerator(http).GenerateAsync(draft, _directory, "test-secret", GeminiGenerator.DefaultModel);
        Assert.Equal(draft.Fingerprint(), result.InputFingerprint); Assert.Contains("총 321", result.UsageSummary);
        Assert.Contains("교사 확인 전", result.GenerationNotice); Assert.Equal(1, handler.Calls);
    }
    [Theory] [InlineData(".pdf", "application/pdf")] [InlineData(".png", "image/png")] [InlineData(".jpg", "image/jpeg")]
    public async Task AttachmentRequestUsesSelectedBytes(string extension, string mime)
    {
        var bytes = extension == ".pdf" ? Encoding.ASCII.GetBytes("%PDF-1.7\nfixture") : extension == ".png" ? new byte[] {137,80,78,71,13,10,26,10,1,2} : new byte[] {255,216,255,1,2};
        var path = Path.Combine(_directory, "사진문제" + extension); await File.WriteAllBytesAsync(path, bytes);
        var draft = await FileImport.ImportAsync(path, _directory); var v = Variant(draft); v["sourceProblem"] = "첨부 파일에서 읽은 테스트 문항";
        using var handler = new Handler(async (request, token) =>
        {
            using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)); var attachment = json.RootElement.GetProperty("input")[0];
            Assert.Equal(mime, attachment.GetProperty("mime_type").GetString()); Assert.Equal(bytes, Convert.FromBase64String(attachment.GetProperty("data").GetString()!));
            return new(HttpStatusCode.OK) { Content = new ByteArrayContent(Envelope(v)) };
        });
        using var http = new HttpClient(handler); await new GeminiGenerator(http).GenerateAsync(draft, _directory, "test-key", GeminiGenerator.DefaultModel);
    }
    [Fact] public async Task PlainDocxExtractsTextButMathRequiresPdf()
    {
        var path = Path.Combine(_directory, "문제.docx");
        void Write(string inner)
        {
            using var file = File.Create(path); using var zip = new ZipArchive(file, ZipArchiveMode.Create);
            using var writer = new StreamWriter(zip.CreateEntry("word/document.xml").Open());
            writer.Write("<w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main' xmlns:m='http://schemas.openxmlformats.org/officeDocument/2006/math'><w:body>" + inner + "</w:body></w:document>");
        }
        Write("<w:p><w:r><w:t>수소 2 mol의 질량은?</w:t></w:r></w:p>");
        Assert.Equal("수소 2 mol의 질량은?", (await FileImport.ImportAsync(path, _directory)).Body);
        Write("<w:p><m:oMath><m:r><m:t>H₂</m:t></m:r></m:oMath></w:p>");
        Assert.Contains("PDF", (await Assert.ThrowsAsync<ArgumentException>(() => FileImport.ImportAsync(path, _directory))).Message);
    }
    [Theory] [InlineData(".hwp")] [InlineData(".pdf")] [InlineData(".png")] [InlineData(".jpg")]
    public async Task UnsupportedOrDisguisedFilesRejected(string extension)
    { var path = Path.Combine(_directory, "가짜" + extension); await File.WriteAllTextAsync(path, "not-an-attachment"); await Assert.ThrowsAsync<ArgumentException>(() => FileImport.ImportAsync(path, _directory)); }
    [Fact] public async Task EmptyAndOversizedFilesRejected()
    {
        var path = Path.Combine(_directory, "빈파일.txt"); await File.WriteAllBytesAsync(path, []);
        await Assert.ThrowsAsync<ArgumentException>(() => FileImport.ImportAsync(path, _directory));
        using (var stream = File.OpenWrite(path)) stream.SetLength(FileImport.MaxBytes + 1L);
        await Assert.ThrowsAsync<ArgumentException>(() => FileImport.ImportAsync(path, _directory));
    }
    [Fact] public async Task MissingKeyDoesNotSendRequest()
    {
        var draft = await ImportText(); using var handler = new Handler((_, _) => throw new Exception("must not call")); using var http = new HttpClient(handler);
        await Assert.ThrowsAsync<ArgumentException>(() => new GeminiGenerator(http).GenerateAsync(draft, _directory, "", GeminiGenerator.DefaultModel)); Assert.Equal(0, handler.Calls);
    }
    [Theory] [InlineData(403, "인증")] [InlineData(429, "한도")] [InlineData(404, "모델")] [InlineData(500, "오류")]
    public async Task ApiFailuresAreExplicitAndNeverRetried(int status, string expected)
    {
        using var handler = new Handler((_, _) => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status))); using var http = new HttpClient(handler);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => new GeminiGenerator(http).GenerateAsync(SampleProblems.Nitrogen(), _directory, "test-key", GeminiGenerator.DefaultModel));
        Assert.Contains(expected, error.Message); Assert.Equal(1, handler.Calls);
    }
    [Theory] [InlineData("copied")] [InlineData("wrong-source")] [InlineData("duplicates")] [InlineData("missing")] [InlineData("answer-index")] [InlineData("wrong-type")]
    public async Task InvalidGenerationCannotBecomeResult(string issue)
    {
        var draft = await ImportText(); var v = Variant(draft);
        switch (issue)
        {
            case "copied": v["body"] = draft.Body; break;
            case "wrong-source": v["sourceProblem"] = "파일에 없는 문제"; break;
            case "duplicates": v["choices"] = new[] { "1", "2", "2", "4", "5" }; break;
            case "missing": v.Remove("explanation"); break;
            case "answer-index": v["answerIndex"] = 5; break;
            case "wrong-type": v["steps"] = 1; break;
        }
        Assert.Throws<InvalidDataException>(() => GeminiGenerator.ParseResponse(Envelope(v), draft, GeminiGenerator.DefaultModel));
    }
    [Fact] public async Task NonProblemAndTruncatedResponseAreNotFakeSuccess()
    {
        var draft = await ImportText(); var v = Variant(draft); v["status"] = "unsupported"; v["message"] = "화학 문제가 없는 자료입니다.";
        Assert.Throws<UnsupportedProblemException>(() => GeminiGenerator.ParseResponse(Envelope(v), draft, GeminiGenerator.DefaultModel));
        Assert.Throws<InvalidDataException>(() => GeminiGenerator.ParseResponse("{broken"u8.ToArray(), draft, GeminiGenerator.DefaultModel));
    }
    [Fact] public async Task TwinResultMustKeepTheProvidedDynamicStepCount()
    {
        var draft=(await ImportText()) with{Answer="0.1 mol",Explanation="질량을 몰질량으로 나눈 뒤 반응식의 계수비를 적용하고 마지막으로 조건에 대입해 확인한다.",Steps=["주어진 양 확인","몰수 계산","계수비 적용","조건 대입 검산"],UseSolutionLogic=true};
        var valid=Variant(draft);valid["steps"]=new[]{"새 조건 확인","새 몰수 계산","같은 계수비 적용","새 조건 대입 검산"};
        Assert.Equal(4,GeminiGenerator.ParseResponse(Envelope(valid),draft,GeminiGenerator.DefaultModel).Steps.Length);
        valid["steps"]=new[]{"조건 확인","계산","검산"};
        Assert.Throws<InvalidDataException>(()=>GeminiGenerator.ParseResponse(Envelope(valid),draft,GeminiGenerator.DefaultModel));
    }
    [Fact] public async Task CancellationStopsPendingRequest()
    {
        var draft = await ImportText(); using var cancel = new CancellationTokenSource();
        using var handler = new Handler(async (_, token) => { cancel.Cancel(); await Task.Delay(Timeout.Infinite, token); return new(HttpStatusCode.OK); });
        using var http = new HttpClient(handler);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new GeminiGenerator(http).GenerateAsync(draft, _directory, "test-key", GeminiGenerator.DefaultModel, token: cancel.Token));
        Assert.Equal(1, handler.Calls);
    }
}
