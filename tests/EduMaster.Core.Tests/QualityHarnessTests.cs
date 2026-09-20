using EduMaster.Core;
using EduMaster.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Net;
namespace EduMaster.Core.Tests;

public class QualityHarnessTests
{
    private static SampleResult Heating()=>new(Guid.NewGuid(),Guid.NewGuid(),"fp","가열 농도","2 M NaOH 수용액을 가열한다. 물의 증발은 무시한다. 밀도는 d1과 d2이다. NaOH의 몰질량은 40 g/mol이다. 몰농도와 몰랄 농도는?",["d2/d1 ; 50/(25d1 - 2)","2d2/d1 ; 50/(25d2 - 2)","2d1/d2 ; 50/(25d1 - 2)","2d2/d1 ; 50/(25d1 - 2)","2d2/d1 ; 25/(25d1 - 2)"],"④ 2d2/d1 ; 50/(25d1 - 2)","질량 보존과 증발 무시로 두 농도를 계산한다.",["몰수 계산","용매 질량 계산","부피 대조"],"새 수치");
    [Fact]public void HeatingCorrectAndWrongAnswersAreDistinguished(){var r=Heating();Assert.Equal("pass",HeatingConcentrationCheck.Inspect(r)!.State);Assert.Equal("fail",HeatingConcentrationCheck.Inspect(r with{Answer="② "+r.Choices[1]})!.State);}
    [Fact]public void CommaSeparatedSymbolicChoicesAreAlsoChecked(){var r=Heating();Assert.Equal("pass",HeatingConcentrationCheck.Inspect(r with{Choices=r.Choices.Select(c=>c.Replace(" ; ",", ")).ToArray()})!.State);}
    [Fact]public void NumericHeatingChecksUnitsRoundingAndAnswer(){var r=Heating() with{Body="2 M NaOH 수용액을 가열한다. (가)의 밀도는 1.08 g/mL, (나)의 밀도는 1.06 g/mL이다. NaOH의 몰질량은 40 g/mol이고 물의 증발은 무시한다. 몰농도와 몰랄 농도는?",Choices=["1.96 M, 2 m","1.96 M, 2.04 m","2.00 M, 2 m","2.04 M, 2 m","1.96 M, 1.96 m"],Answer="① 1.96 M, 2 m"};Assert.Equal("pass",HeatingConcentrationCheck.Inspect(r)!.State);Assert.Equal("fail",HeatingConcentrationCheck.Inspect(r with{Answer="③ "+r.Choices[2]})!.State);}
    [Fact]public void EquivalentDuplicateAnswersAreNotAccepted(){var r=Heating();var cs=r.Choices.ToArray();cs[0]="100d2/(50d1) ; 2/(d1 - 0.08)";Assert.Equal("fail",HeatingConcentrationCheck.Inspect(r with{Choices=cs})!.State);}
    [Fact]public void EvaporationOrUnsupportedMathIsNotClaimedVerified(){var r=Heating();Assert.Null(HeatingConcentrationCheck.Inspect(r with{Body=r.Body.Replace("물의 증발은 무시한다.","물이 증발한다.")}));Assert.Null(HeatingConcentrationCheck.Inspect(r with{Choices=["sqrt(d1)","1","2","3","4"]}));}
    [Fact]public void FailedChecksBlockExportAndUnknownChecksRemainVisible(){var r=Heating();var ok=ProblemQualityHarness.Inspect(r);Assert.Equal("review_required",ok.State);Assert.True(ok.CanExport);Assert.Contains(ok.Checks,c=>c.Id=="render"&&c.State=="unknown");var bad=ProblemQualityHarness.Inspect(r with{Answer="⑤ "+r.Choices[4]});Assert.Equal("fail",bad.State);Assert.False(bad.CanExport);}
    [Fact]public void MissingDrawingAndMismatchedInputAreFailures(){var r=Heating();var d=new ProblemDraft{Title="입력",Body="다른 문제"};var report=ProblemQualityHarness.Inspect(r with{RequiresVisuals=true},d);Assert.Contains(report.Checks,c=>c.Id=="visual-data"&&c.State=="fail");Assert.Contains(report.Checks,c=>c.Id=="input"&&c.State=="fail");}
    [Fact]public void ReactionMassContradictionIsCaughtEvenWhenQuestionAndUnknownChange(){
        const string body="""
A(g) + bB(g) → 2C(g) + 2D(g)
| 실험 | 반응 전 A 질량(g) | 반응 전 B 질량(g) | 반응 후 질량(g) | D/전체 기체 상댓값 |
| Ⅰ | 6w | 6w | A (12)/(2)w | y = 20 |
| Ⅱ | 5w | 7w | A 3w | 24 |
| Ⅲ | 3w | 8w | B 2w | 30 |
(b)/(y) × (C의 물질량 + D의 물질량)/(B의 물질량)은?
""";
        Assert.Null(ReactionMassCheck.Solve(body));
        var report=ProblemQualityHarness.Inspect(Heating() with{Body=body});
        Assert.Contains(report.Checks,c=>c.Id=="reaction-conditions"&&c.State=="fail"&&c.Evidence.Contains("6w"));Assert.False(report.CanExport);
        var old=report with{Checks=report.Checks.Where(c=>c.Id!="reaction-conditions").ToArray()};
        Assert.Contains(ProblemQualityHarness.Merge(old,report.Checks.Where(c=>c.Method=="code")).Checks,c=>c.Id=="reaction-conditions"&&c.State=="fail");
    }
    [Fact]public void PartialLearningStageIsNotRejectedForOmittingLaterTwinStructure(){
        const string partialBody="""
A(g) + B(g) → C(g)
| 실험 | 반응 전 A 질량(g) | 반응 전 B 질량(g) | 반응 후 질량(g) |
| I | 6w | 6w | (12)/(2)w |
STEP 1의 한계 반응물을 고르면?
""";
        var draft=new ProblemDraft{Title="기준 · STEP 1",Body=ReactionVariantPlanTests.Source,Answer="",Explanation="한계 반응물만 판별한다.",Steps=["한계 반응물 가정과 모순 확인"],UseSolutionLogic=true,SkipDeterministicPlan=true,LogicScope="중간 1/3단계 연습 문제"};
        var r=Heating() with{InputId=draft.Id,InputFingerprint=draft.Fingerprint(),Body=partialBody,Steps=draft.Steps};
        var report=ProblemQualityHarness.Inspect(r,draft);
        Assert.DoesNotContain(report.Checks,c=>c.Id is "source-reaction-type" or "reaction-conditions");
        Assert.DoesNotContain(report.Checks,c=>c.State=="fail");
    }
    [Fact]public void CachedPartialStageRemovesOldFullTwinFalsePositives(){
        var r=Heating();var old=new QualityReport(QualityReport.CurrentVersion,[
            new("source-reaction-type","원본 풀이 구조","fail","전체 문제와 다름","code"),
            new("reaction-conditions","반응 표의 질량 조건","fail","표가 다름","code"),
            new("input","입력 연결","pass","기존 입력 확인","code"),
            new("language","문장·표현","skipped","선행 오류","ai-deepseek"),
            new("render","최종 PNG 대조","skipped","선행 오류","local-vision")]);
        var refreshed=ProblemQualityHarness.RefreshPartialStage(r with{Quality=old});
        Assert.DoesNotContain(refreshed.Checks,c=>c.Id is "source-reaction-type" or "reaction-conditions");
        Assert.Contains(refreshed.Checks,c=>c.Id=="input"&&c.State=="pass");
        Assert.Contains(refreshed.Checks,c=>c.Id=="language"&&c.State=="unknown");
        Assert.Contains(refreshed.Checks,c=>c.Id=="render"&&c.State=="unknown");
        Assert.DoesNotContain(refreshed.Checks,c=>c.State=="fail");
    }
    [Fact]public void PartialLimitingReactantProblemRejectsAnswerClueInTable(){
        var draft=new ProblemDraft{Title="기준 · STEP 1",Body=ReactionVariantPlanTests.Source,Answer="",Explanation="한계 반응물을 판별한다.",Steps=["한계 반응물 가정과 여러 실험의 모순 비교"],UseSolutionLogic=true,SkipDeterministicPlan=true,LogicScope="중간 단계"};
        var body="""
A(g) + 2B(g) → 2C(g) + 2D(g)
| 실험 | 반응 전 A | 반응 전 B | 반응 후 잔류 질량 |
| I | 6w | 4w | A 2w |
한계 반응물은?
""";
        var report=ProblemQualityHarness.Inspect(Heating() with{InputId=draft.Id,InputFingerprint=draft.Fingerprint(),Body=body,Steps=draft.Steps},draft);
        Assert.Contains(report.Checks,c=>c.Id=="stage-clue-leak"&&c.State=="fail");
    }
    [Fact]public void MalformedReviewNeverBecomesPass(){var checks=new[]{new{id="language",state="pass",evidence="확인"}};Assert.Throws<InvalidDataException>(()=>QualityReviewClient.ParseText(Envelope(new{checks}),"ai"));Assert.Throws<InvalidDataException>(()=>QualityReviewClient.ParseText(Envelope(new{checks},"length"),"ai"));}
    [Fact]public void FencedReviewJsonIsAcceptedButStillStrictlyValidated(){var checks=new[]{new{id="language",state="pass",evidence="문장 확인"},new{id="conditions",state="pass",evidence="조건 확인"},new{id="semantic-math",state="pass",evidence="수치 확인"},new{id="visual-semantics",state="pass",evidence="그림 불필요"}};var content="```json\n"+JsonSerializer.Serialize(new{checks})+"\n```";var bytes=JsonSerializer.SerializeToUtf8Bytes(new{choices=new[]{new{finish_reason="stop",message=new{content}}}});Assert.All(QualityReviewClient.ParseText(bytes,"ai"),c=>Assert.Equal("pass",c.State));}
    [Fact]public async Task ReviewerDisconnectLeavesUnknownRatherThanFailingGeneration(){using var http=new HttpClient(new Handler());var r=await new QualityReviewClient(http).ReviewTextAsync(Heating(),null,"gemma","http://127.0.0.1:8092/v1","test",null);Assert.Equal("review_required",r.Quality!.State);Assert.Contains(r.Quality.Checks,c=>c.Id=="language"&&c.State=="unknown");}
    [Fact]public async Task DeepSeekReviewReceivesReadableKoreanAndBoundedJsonBudget(){
        var handler=new CaptureHandler();using var http=new HttpClient(handler);
        await new QualityReviewClient(http).ReviewTextAsync(Heating(),null,"deepseek","https://api.deepseek.com","deepseek-flash","fixture-key");
        using var payload=JsonDocument.Parse(handler.Payload!);var root=payload.RootElement;
        var material=root.GetProperty("messages")[1].GetProperty("content").GetString()!;
        Assert.Contains("가열 농도",material);Assert.DoesNotContain("\\u",material);
        Assert.Equal("disabled",root.GetProperty("thinking").GetProperty("type").GetString());
        Assert.Equal(4000,root.GetProperty("max_tokens").GetInt32());Assert.Equal(JsonValueKind.Null,root.GetProperty("chat_template_kwargs").ValueKind);
    }
    [Fact]public async Task PartialLearningScopeIsSentToReviewer(){
        var draft=new ProblemDraft{Title="기준 · STEP 1",Body=ReactionVariantPlanTests.Source,Answer="",Explanation="한계 반응물만 판별한다.",Steps=["한계 반응물 가정과 모순 확인"],UseSolutionLogic=true,SkipDeterministicPlan=true,LogicScope="중간 1/3단계 연습 문제입니다. STEP 1까지만 사용합니다."};
        var r=Heating() with{InputId=draft.Id,InputFingerprint=draft.Fingerprint(),Steps=draft.Steps};var handler=new CaptureHandler();using var http=new HttpClient(handler);
        await new QualityReviewClient(http).ReviewTextAsync(r,draft,"deepseek","https://api.deepseek.com","deepseek-flash","fixture-key");
        using var payload=JsonDocument.Parse(handler.Payload!);using var material=JsonDocument.Parse(payload.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!);
        Assert.Equal(draft.LogicScope,material.RootElement.GetProperty("learningScope").GetString());
        Assert.Single(material.RootElement.GetProperty("referenceLogicSteps").EnumerateArray());
        Assert.Equal(JsonValueKind.Array,material.RootElement.GetProperty("forbiddenLaterSteps").ValueKind);
    }
    [Fact]public async Task PartialStageFalsePositiveNeedsIndependentAppeal(){
        var draft=new ProblemDraft{Title="기준 · STEP 1",Body="가열 농도 기준 문제",Answer="",Explanation="여러 실험을 비교한다.",Steps=["여러 실험의 수치를 비교해 모순을 판정한다"],ExcludedSteps=["농도를 계산한다"],UseSolutionLogic=true,SkipDeterministicPlan=true,LogicScope="중간 단계"};
        var r=Heating() with{InputId=draft.Id,InputFingerprint=draft.Fingerprint(),Body="두 실험의 수치를 비교해 모순되는 가정을 고른다.",Steps=draft.Steps};
        var first=Envelope(new{checks=new[]{new{id="language",state="pass",evidence="정상"},new{id="conditions",state="fail",evidence="여러 실험 비교는 다음 단계다"},new{id="semantic-math",state="pass",evidence="계산 정상"},new{id="visual-semantics",state="pass",evidence="그림 불필요"}}});
        var second=Envelope(new{decisions=new[]{new{id="conditions",upheld=false,evidence="여러 실험 비교는 allowedSteps에 명시되어 있다"}}});
        using var http=new HttpClient(new SequenceReplyHandler(first,second));var reviewed=await new QualityReviewClient(http).ReviewTextAsync(r,draft,"deepseek","https://api.deepseek.com","deepseek-flash","test");
        Assert.Contains(reviewed.Quality!.Checks,c=>c.Id=="conditions"&&c.State=="pass"&&c.Method=="ai-deepseek-appeal");
        Assert.Contains(reviewed.Quality.Checks,c=>c.Id=="calculation"&&c.State=="pass"&&c.Method=="ai-deepseek-fallback");
    }
    [Fact]public async Task VerifiedReactionTwinIsNotFailedBecauseAllMassesWereScaled(){
        var draft=new ProblemDraft{Title="기준",Body=ReactionVariantPlanTests.Source,Answer="② 2/5",Explanation="검증 풀이",Steps=ReactionMassCheck.Solve(ReactionVariantPlanTests.Source)!.Steps,UseSolutionLogic=true};
        var plan=ReactionVariantPlan.Create(draft)!;
        var seed=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"쌍둥이",plan.Body,plan.Choices,plan.Answer,string.Join("\n",plan.Solution.Steps),plan.Solution.Steps,"공통 배율") {SourceProblem=draft.Body,SourceSteps=draft.Steps};
        var modelChecks=new[]{new{id="language",state="pass",evidence="문장 정상"},new{id="conditions",state="fail",evidence="숫자가 달라 로직이 바뀌었다"},new{id="semantic-math",state="fail",evidence="배율 수치가 원본과 다르다"},new{id="visual-semantics",state="pass",evidence="그림 불필요"}};
        using var http=new HttpClient(new ReplyHandler(Envelope(new{checks=modelChecks})));
        var reviewed=await new QualityReviewClient(http).ReviewTextAsync(seed,draft,"deepseek","https://api.deepseek.com","deepseek-flash","test");
        Assert.Contains(reviewed.Quality!.Checks,c=>c.Id=="conditions"&&c.State=="pass"&&c.Method=="code-reaction-twin");
        Assert.Contains(reviewed.Quality.Checks,c=>c.Id=="semantic-math"&&c.State=="pass"&&c.Method=="code-reaction-twin");
    }
    [Fact]public void BeakerTemplateHasStableLayoutAndRetainsLabels(){var templates=ScientificTemplates.Parse(JsonNode.Parse("""
[{"type":"beaker-sequence","title":"가열","containers":[{"label":"(가)","labels":["2 M NaOH","25℃"],"liquidLevel":0.55},{"label":"(나)","labels":["50℃"],"liquidLevel":0.55}],"transitionLabel":"가열"}]
"""));var drawing=ScientificTemplates.Compile(templates[0]);Assert.Equal(2,drawing.Elements.Count(e=>e.Type=="beaker"));Assert.Contains(drawing.Elements,e=>e.Text=="2 M NaOH");Assert.Contains(drawing.Elements,e=>e.Text=="가열"&&e.Type=="text");Assert.DoesNotContain(drawing.Elements,e=>e.Type=="rect");Assert.Single(ScientificVisuals.ParseDrawings(JsonNode.Parse(JsonSerializer.Serialize(new[]{drawing},new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase}))));}
    [Fact]public void BadTemplateCannotInventOrClampLiquidLevel(){Assert.Throws<InvalidDataException>(()=>ScientificTemplates.Parse(JsonNode.Parse("""
[{"type":"beaker-sequence","title":"실험","containers":[{"label":"(가)","labels":[],"liquidLevel":2}],"transitionLabel":""}]
""")));}
    [Fact]public void HugeOrNonPngInputRejected(){Assert.Throws<ArgumentException>(()=>RenderedImageInput.Decode("data:image/jpeg;base64,AAAA"));Assert.Throws<ArgumentException>(()=>RenderedImageInput.Decode("data:image/png;base64,AAAA"));}
    [Fact]public async Task ImageReviewMustReturnObservedChoicesBeforeItCanPass(){var r=Heating();using var http=new HttpClient(new ReplyHandler(Envelope(new{state="pass",evidence="글자 일치",observedChoices=r.Choices.Select((s,i)=>"①②③④⑤"[i]+" "+s.Replace("d1","d₁").Replace("d2","d₂")).ToArray(),observedLabels=Array.Empty<string>()})));Assert.Equal("pass",(await new QualityReviewClient(http).ReviewRenderedAsync(r,[1],false)).State);using var badHttp=new HttpClient(new ReplyHandler(Envelope(new{state="pass",evidence="검사 완료",observedChoices=new[]{"999","2","3","4","5"},observedLabels=Array.Empty<string>()})));Assert.Equal("unknown",(await new QualityReviewClient(badHttp).ReviewRenderedAsync(r,[1],false)).State);using var missingHttp=new HttpClient(new ReplyHandler(Envelope(new{state="pass",evidence="모두 정상"})));Assert.Equal("unknown",(await new QualityReviewClient(missingHttp).ReviewRenderedAsync(r,[1],false)).State);}
    private static byte[] Envelope(object content,string finish="stop")=>JsonSerializer.SerializeToUtf8Bytes(new{choices=new[]{new{finish_reason=finish,message=new{content=JsonSerializer.Serialize(content)}}}});
    private sealed class Handler:HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));}
    private sealed class CaptureHandler:HttpMessageHandler{public string? Payload;protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t){Payload=await r.Content!.ReadAsStringAsync(t);return new(HttpStatusCode.ServiceUnavailable);}}
    private sealed class ReplyHandler(byte[] content):HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(content)});}
    private sealed class SequenceReplyHandler(params byte[][] replies):HttpMessageHandler{private int index;protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(replies[Math.Min(index++,replies.Length-1)])});}
}
