using System.Net;
using System.Text.Json;
using EduMaster.Core;
namespace EduMaster.Core.Tests;

public class DeepSeekVisualTests
{
    private static ProblemDraft Draft() => new() { Title = "탄산칼슘", Body = "탄산칼슘 10 g을 분해한다. 몰질량 100 g/mol. CO₂ 양은?" };
    private static byte[] Response(ProblemDraft draft, string finish = "stop", string? fingerprint = null) => JsonSerializer.SerializeToUtf8Bytes(new
    {
        choices = new[]
        {
            new
            {
                finish_reason = finish,
                message = new
                {
                    role = "assistant",
                    content = JsonSerializer.Serialize(new
                    {
                        status = "ready",
                        message = "",
                        inputFingerprint = fingerprint ?? draft.Fingerprint(),
                        sourceLocation = "기준 자료",
                        title = "새 문제",
                        body = "탄산칼슘 20 g을 분해한다. CO₂ 양은?",
                        choices = new[] { "0.1 mol", "0.2 mol", "0.3 mol", "0.4 mol", "0.5 mol" },
                        answerText = "0.2 mol",
                        explanation = "20/100=0.2 mol",
                        steps = new[] { "몰질량", "몰수", "계수비" },
                        changeSummary = "10g→20g"
                    })
                }
            }
        },
        usage = new { prompt_tokens = 100, completion_tokens = 200, total_tokens = 300 }
    });

    [Fact]public void UnknownAnswerCannotBecomeFirstChoice(){
        var draft=Draft();var bytes=Response(draft);using var root=JsonDocument.Parse(bytes);
        var node=System.Text.Json.Nodes.JsonNode.Parse(bytes)!;
        var variant=System.Text.Json.Nodes.JsonNode.Parse(node["choices"]![0]!["message"]!["content"]!.GetValue<string>())!;
        variant["answerText"]="999 mol";node["choices"]![0]!["message"]!["content"]=variant.ToJsonString();
        Assert.Throws<InvalidDataException>(()=>DeepSeekVisualGenerator.ParseResponse(JsonSerializer.SerializeToUtf8Bytes(node),draft));
    }
    [Fact]public void RejectsLengthEvenWhenReadingHasEnoughText(){
        var bytes=JsonSerializer.SerializeToUtf8Bytes(new{choices=new[]{new{finish_reason="length",message=new{content="이미지에 있는 일부 조건만 읽은 긴 문자열입니다."}}}});
        Assert.Throws<InvalidDataException>(()=>DeepSeekVisualGenerator.ParseReading(bytes));
    }
    [Fact]
    public void KeepsInputFingerprintAndCloudUsage()
    {
        var d = Draft();
        var r = DeepSeekVisualGenerator.ParseResponse(Response(d), d);
        Assert.Equal(d.Fingerprint(), r.InputFingerprint);
        Assert.Equal("② 0.2 mol", r.Answer);
        Assert.Contains("DeepSeek API", r.UsageSummary);
        Assert.Contains("300", r.UsageSummary);
    }

    [Fact]
    public void RejectsAnotherInputsResponse()
    {
        var d = Draft();
        Assert.Throws<InvalidDataException>(() => DeepSeekVisualGenerator.ParseResponse(Response(d, fingerprint: "wrong"), d));
    }

    [Fact]
    public void RejectsTruncatedResponse()
    {
        var d = Draft();
        Assert.Throws<InvalidDataException>(() => DeepSeekVisualGenerator.ParseResponse(Response(d, "length"), d));
    }

    private sealed class Handler(int transientFailures = 0) : HttpMessageHandler
    {
        public int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (++Calls <= transientFailures) return new(HttpStatusCode.ServiceUnavailable);
            Assert.Equal("Bearer test-key", request.Headers.GetValues("Authorization").Single());
            using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            var messages = json.RootElement.GetProperty("messages");
            var userMsg = messages[1].GetProperty("content");
            var text = userMsg.ValueKind == JsonValueKind.Array ? userMsg[0].GetProperty("text").GetString()! : userMsg.GetString()!;
            using var source = JsonDocument.Parse(text);
            var fp = source.RootElement.GetProperty("inputFingerprint").GetString();
            return new(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(Response(Draft(), fingerprint: fp))
            };
        }
    }

    [Fact]
    public async Task SendsOriginalImageAndBearerToken()
    {
        using var client = new HttpClient(new Handler());
        var result = await new DeepSeekVisualGenerator(client).GenerateAsync(Draft(), "test-key", images: [new([1, 2, 3], "image/png", 1)]);
        Assert.Equal(1, result.ImageInputCount);
        Assert.Single(result.Figures);
    }

    [Fact]
    public async Task RecoversFromTransientServiceFailure()
    {
        var handler = new Handler(1);
        using var client = new HttpClient(handler);
        var result = await new DeepSeekVisualGenerator(client).GenerateAsync(Draft(), "test-key", images: [new([1, 2, 3], "image/png", 1)]);
        Assert.Equal(2, handler.Calls);
        Assert.Equal("② 0.2 mol", result.Answer);
    }

    [Fact]
    public void ParsesValidJsonReading()
    {
        var raw = JsonSerializer.SerializeToUtf8Bytes(new
        {
            choices = new[]
            {
                new
                {
                    finish_reason = "stop",
                    message = new
                    {
                        role = "assistant",
                        content = "{\"body\": \"화학 반응식 A(g) \\\\longrightarrow B(g) \\\\times 2\"}"
                    }
                }
            }
        });
        var result = DeepSeekVisualGenerator.ParseReading(raw);
        Assert.Equal("화학 반응식 A(g) → B(g) × 2", result);
    }

    [Fact]
    public void ParsesMarkdownWrappedJsonReading()
    {
        var raw = JsonSerializer.SerializeToUtf8Bytes(new
        {
            choices = new[]
            {
                new
                {
                    finish_reason = "stop",
                    message = new
                    {
                        role = "assistant",
                        content = "```json\n{\"body\": \"표 자료 Ⅰ~Ⅲ 분석 본문\"}\n```"
                    }
                }
            }
        });
        var result = DeepSeekVisualGenerator.ParseReading(raw);
        Assert.Equal("표 자료 Ⅰ~Ⅲ 분석 본문", result);
    }

    [Fact]
    public void ParsesPlainTextReading()
    {
        var raw = JsonSerializer.SerializeToUtf8Bytes(new
        {
            choices = new[]
            {
                new
                {
                    finish_reason = "stop",
                    message = new
                    {
                        role = "assistant",
                        content = "다음은 실린더 기체 반응 실험 본문이다. A + B → C"
                    }
                }
            }
        });
        var result = DeepSeekVisualGenerator.ParseReading(raw);
        Assert.Equal("다음은 실린더 기체 반응 실험 본문이다. A + B → C", result);
    }

    [Fact]
    public void ThrowsOnReasoningLengthExhaustion()
    {
        var raw = JsonSerializer.SerializeToUtf8Bytes(new
        {
            choices = new[]
            {
                new
                {
                    finish_reason = "length",
                    message = new
                    {
                        role = "assistant",
                        content = "",
                        reasoning_content = "Thinking endlessly about stoichiometry..."
                    }
                }
            }
        });
        var ex = Assert.Throws<InvalidDataException>(() => DeepSeekVisualGenerator.ParseReading(raw));
        Assert.Contains("추론 토큰 한도 초과", ex.Message);
    }

    [Fact]
    public void ThrowsOnUnreadableMarker()
    {
        var raw = JsonSerializer.SerializeToUtf8Bytes(new
        {
            choices = new[]
            {
                new
                {
                    finish_reason = "stop",
                    message = new
                    {
                        role = "assistant",
                        content = "{\"body\": \"일부 글자가 [판독불가] 상태입니다.\"}"
                    }
                }
            }
        });
        var ex = Assert.Throws<InvalidDataException>(() => DeepSeekVisualGenerator.ParseReading(raw));
        Assert.Contains("읽지 못한 부분", ex.Message);
    }

    [Fact]
    public void ParsesProblemGraphWhenProvided()
    {
        var draft = Draft();
        var raw = Response(draft, fingerprint: draft.Fingerprint());
        // Insert graph into json
        var node = System.Text.Json.Nodes.JsonNode.Parse(raw)!.AsObject();
        var choicesArr = node["choices"]!.AsArray();
        var msg = choicesArr[0]!["message"]!["content"]!.GetValue<string>();
        var variantNode = System.Text.Json.Nodes.JsonNode.Parse(msg)!.AsObject();
        variantNode["graph"] = new System.Text.Json.Nodes.JsonObject
        {
            ["type"] = "line",
            ["title"] = "반응 시간에 따른 부피 변화",
            ["xLabel"] = "반응 시간 (s)",
            ["yLabel"] = "생성 기체 부피 (L)",
            ["xPoints"] = new System.Text.Json.Nodes.JsonArray(0, 10, 20, 30),
            ["yPoints"] = new System.Text.Json.Nodes.JsonArray(0, 5.6, 11.2, 11.2),
            ["annotations"] = new System.Text.Json.Nodes.JsonArray("완결점 (20, 11.2)")
        };
        choicesArr[0]!["message"]!["content"] = variantNode.ToJsonString();
        var modifiedRaw = JsonSerializer.SerializeToUtf8Bytes(node);

        var result = DeepSeekVisualGenerator.ParseResponse(modifiedRaw, draft);
        Assert.NotNull(result.Graph);
        Assert.Equal("line", result.Graph.Type);
        Assert.Equal("반응 시간에 따른 부피 변화", result.Graph.Title);
        Assert.Equal("반응 시간 (s)", result.Graph.XLabel);
        Assert.Equal("생성 기체 부피 (L)", result.Graph.YLabel);
        Assert.Equal(4, result.Graph.XPoints.Length);
        Assert.Equal(4, result.Graph.YPoints.Length);
        Assert.Equal(11.2, result.Graph.YPoints[2]);
        Assert.Single(result.Graph.Annotations!);
    }
}

