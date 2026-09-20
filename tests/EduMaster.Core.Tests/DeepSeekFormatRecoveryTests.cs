using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using EduMaster.Core;
namespace EduMaster.Core.Tests;
public class DeepSeekFormatRecoveryTests
{
    [Fact]public void RepeatedChoiceNumbersAndExactDuplicateBodyChoicesAreRemoved()
    {
        var draft=new ProblemDraft{Body="2+3의 값을 구하시오."};var value=Valid(draft);value["choices"]=new JsonArray("① 5","② 6","③ 7","④ 8","⑤ 9");value["answerText"]="③ 7";value["body"]="3+4의 값을 구하시오. ① 5 ② 6 ③ 7 ④ 8 ⑤ 9";
        var bytes=JsonSerializer.SerializeToUtf8Bytes(new{choices=new[]{new{finish_reason="stop",message=new{content=value.ToJsonString()}}}});
        var result=DeepSeekVisualGenerator.ParseResponse(bytes,draft);Assert.Equal("③ 7",result.Answer);Assert.Equal("7",result.Choices[2]);Assert.Equal("3+4의 값을 구하시오.",result.Body);
    }
    [Theory][InlineData("null")][InlineData("[]")][InlineData("{\"status\":")]
    public void NullArrayOrMalformedJsonHasSafeFieldDiagnostic(string content)
    {
        var bytes=JsonSerializer.SerializeToUtf8Bytes(new{choices=new[]{new{finish_reason="stop",message=new{content}}}});
        var error=Assert.Throws<InvalidDataException>(()=>DeepSeekVisualGenerator.ParseResponse(bytes,new ProblemDraft{Body="2+3의 값을 구하시오."}));
        Assert.Equal("문항 JSON",error.Data["DeepSeekFormatStage"]);
    }
    [Fact]public async Task InvalidFieldTypeRewritesOnceAndPreservesOriginalInput()
    {
        var draft=new ProblemDraft{Title="덧셈",Body="2+3의 값을 구하시오."};var calls=0;string? original=null;
        using var http=new HttpClient(new Handler(async request=>{
            var payload=JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;calls++;
            var source=payload["messages"]![1]!["content"]!.ToJsonString();
            if(calls==1)original=source;else{Assert.Equal(original,source);Assert.Equal("disabled",payload["thinking"]!["type"]!.GetValue<string>());}
            var value=Valid(draft);if(calls==1)value["choices"]=new JsonArray(new JsonObject{["text"]="5"},"6","7","8","9");
            return Envelope(value);
        }));
        var result=await new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only");
        Assert.Equal(2,calls);Assert.Equal("③ 7",result.Answer);Assert.Contains("형식 재작성 API 1회",result.UsageSummary);
    }
    [Fact]public async Task RepeatedInvalidDrawingTypeStopsAfterOneRewriteWithFieldDiagnostic()
    {
        var draft=new ProblemDraft{Title="덧셈",Body="2+3의 값을 구하시오."};var calls=0;
        using var http=new HttpClient(new Handler(_=>{calls++;var value=Valid(draft);value["drawings"]=new JsonArray(new JsonObject{["title"]="도형",["width"]="1000",["height"]=600,["elements"]=new JsonArray()});return Task.FromResult(Envelope(value));}));
        var error=await Assert.ThrowsAsync<InvalidDataException>(()=>new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only"));
        Assert.Equal(2,calls);Assert.Contains("drawings",error.Message);Assert.Equal("drawings 도형 좌표·라벨",error.Data["DeepSeekFormatStage"]);
    }
    [Fact]public async Task WrongInputFingerprintIsNeverRewrittenOrAccepted()
    {
        var draft=new ProblemDraft{Title="덧셈",Body="2+3의 값을 구하시오."};var calls=0;
        using var http=new HttpClient(new Handler(_=>{calls++;var value=Valid(draft);value["inputFingerprint"]="other-input";return Task.FromResult(Envelope(value));}));
        await Assert.ThrowsAsync<InvalidDataException>(()=>new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only"));Assert.Equal(1,calls);
    }
    private static JsonObject Valid(ProblemDraft draft)=>new(){["status"]="ready",["message"]="",["inputFingerprint"]=draft.Fingerprint(),["title"]="덧셈 변형",["body"]="3+4의 값을 구하시오.",["sourceLocation"]="기준 문제",["choices"]=new JsonArray("5","6","7","8","9"),["answerText"]="7",["explanation"]="3+4=7이다.",["steps"]=new JsonArray("두 수 확인","덧셈","결과 7 확인"),["changeSummary"]="2,3에서 3,4로 변형",["graph"]=null,["diagrams"]=new JsonArray(),["drawings"]=new JsonArray(),["visualRequirement"]="none"};
    private static HttpResponseMessage Envelope(JsonObject value)=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new{choices=new[]{new{finish_reason="stop",message=new{content=value.ToJsonString()}}}}))};
    private sealed class Handler(Func<HttpRequestMessage,Task<HttpResponseMessage>> send):HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)=>send(request);}
}
