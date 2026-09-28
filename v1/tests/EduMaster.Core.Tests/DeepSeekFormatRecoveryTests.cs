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
    [Fact]public async Task AnswerOutsideChoicesGetsOneBoundedRecoveryInsteadOfEndingStageImmediately()
    {
        var draft=new ProblemDraft{Title="덧셈",Body="2+3의 값을 구하시오."};var calls=0;
        using var http=new HttpClient(new Handler(async request=>{
            calls++;var payload=JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
            var value=Valid(draft);
            if(calls==1)value["answerText"]="999";
            else Assert.Contains("answerText는 보기 번호 없이 choices",payload["messages"]![0]!["content"]!.GetValue<string>());
            return Envelope(value);
        }));
        var result=await new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only");
        Assert.Equal(2,calls);Assert.Equal("③ 7",result.Answer);
    }
    [Fact]public async Task OutputLimitRetriesOnceWithoutThinkingAndReturnsOnlyCompleteResult()
    {
        var draft=new ProblemDraft{Title="덧셈",Body="2+3의 값을 구하시오."};var calls=0;
        using var http=new HttpClient(new Handler(async request=>{
            var payload=JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;calls++;
            if(calls==2){Assert.Equal("disabled",payload["thinking"]!["type"]!.GetValue<string>());Assert.Null(payload["reasoning_effort"]);Assert.Contains("전체 2500자 이내",payload["messages"]![0]!["content"]!.GetValue<string>());}
            return Envelope(Valid(draft),calls==1?"length":"stop");
        }));
        var result=await new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only");
        Assert.Equal(2,calls);Assert.Equal("③ 7",result.Answer);Assert.Contains("출력 한도 자동 재작성 API 1회",result.UsageSummary);
    }
    private static JsonObject Valid(ProblemDraft draft)=>new(){["status"]="ready",["message"]="",["inputFingerprint"]=draft.Fingerprint(),["title"]="덧셈 변형",["body"]="3+4의 값을 구하시오.",["sourceLocation"]="기준 문제",["choices"]=new JsonArray("5","6","7","8","9"),["answerText"]="7",["explanation"]="3+4=7이다.",["steps"]=new JsonArray("두 수 확인","덧셈","결과 7 확인"),["changeSummary"]="2,3에서 3,4로 변형",["graph"]=null,["diagrams"]=new JsonArray(),["drawings"]=new JsonArray(),["visualRequirement"]="none"};
    private static HttpResponseMessage Envelope(JsonObject value,string finish="stop")=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new{choices=new[]{new{finish_reason=finish,message=new{content=value.ToJsonString()}}}}))};
    [Fact]public async Task CheckedLearningDesignStillSendsSavedFeedbackToModel()
    {
        var stage=LearningStagePlan.Build(ReactionLearningPlanTests.FailedSource())[1];
        var plan=ReactionLearningPlan.Create(stage.Draft,2,3)!;
        const string feedback="해야 할 것: 원본 보조 문자를 보존한다. 하지 말아야 할 것: 무관한 조건을 추가하지 않는다.";
        using var http=new HttpClient(new Handler(async request=>{
            var payload=JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
            Assert.Equal("disabled",payload["thinking"]!["type"]!.GetValue<string>());
            Assert.Equal(800,payload["max_tokens"]!.GetValue<int>());
            Assert.Equal(feedback,payload["messages"]![1]!["content"]!.GetValue<string>());
            var value=new JsonObject{["style"]="beginner",["unsupported"]=new JsonArray()};
            // Unsolicited model edits cannot replace the code-verified question.
            value["body"]="모델이 임의로 만든 문제";value["answerText"]="999";
            return Envelope(value);
        }));
        var style=await new DeepSeekVisualGenerator(http).ReadLearningPreferencesAsync(feedback,"test-only");
        var result=ReactionLearningPlan.Create(stage.Draft,2,3,style)!;
        Assert.Equal(plan.Body,result.Body);Assert.Equal(plan.Answer,result.Answer);
        Assert.Contains("입자 수",result.Explanation);Assert.Equal("pass",ReactionLearningPlan.Inspect(result)!.State);
    }
    [Fact]public async Task UnsupportedFeedbackIsNotClaimedAsApplied()
    {
        var calls=0;
        using var http=new HttpClient(new Handler(_=>{calls++;return Task.FromResult(Envelope(new JsonObject{["style"]="teacher",["unsupported"]=new JsonArray("보조 문자를 t로 바꾼다")}));}));
        await Assert.ThrowsAsync<UnsupportedProblemException>(()=>new DeepSeekVisualGenerator(http).ReadLearningPreferencesAsync("보조 문자를 t로 바꾼다","test-only"));
        Assert.Equal(1,calls);
    }
    private sealed class Handler(Func<HttpRequestMessage,Task<HttpResponseMessage>> send):HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)=>send(request);}
}
