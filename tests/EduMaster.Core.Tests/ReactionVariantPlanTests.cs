using EduMaster.Core;
namespace EduMaster.Core.Tests;
public class ReactionVariantPlanTests
{
    public const string Source="""
A(g) + bB(g) → 2C(g) + 2D(g) (b는 반응 계수)
| 실험 | 반응 전 A 질량(g) | 반응 전 B 질량(g) | 반응 후 잔류 질량(g) | D의 양/전체 기체의 양 (상댓값) |
| I | 5w | 5w | A (10/3)w | x |
| II | 4w | 6w | A 2w | 18 |
| III | 2w | 7w | B w | 20 |
(b/x) × (C의 몰질량 + D의 몰질량)/(B의 몰질량)은?
""";
    [Fact]public void PlansPreserveCalculatedRelationsAcrossInputScalesAndRelativeValues(){
        foreach(var relative in new[]{18,20})foreach(var factor in new[]{2,3,4,5}){
            var source=ReactionMassCheck.UniformMassVariantBody(Source.Replace("B w | 20","B w | "+relative),factor);
            var draft=new ProblemDraft{Title="직접 작성한 반응량 예제",Body=source};var plan=ReactionVariantPlan.Create(draft)!;
            Assert.NotNull(plan);Assert.Equal(ReactionMassCheck.Solve(source)!.Value,plan.Solution.Value,7);Assert.Equal(5,plan.Choices.Distinct().Count());
            Assert.Equal("pass",ReactionMassCheck.InspectMassConditions(plan.Body)!.State);Assert.DoesNotContain("x=",plan.Body.Replace(" ",""));
            var placeholder=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"초안","잘못된 표",["1","2","3","4","5"],"② 2","틀린 계산",["a","b","c"],"변형"){Model="Gemma 4 12B",SourceProblem=source};
            var r=plan.Apply(placeholder);Assert.Equal(r.Answer,ReactionMassCheck.Verify(r).Answer);Assert.Equal(source,r.SourceProblem);Assert.Equal(draft.Fingerprint(),r.InputFingerprint);Assert.Contains("코드 반응량 템플릿",r.GenerationNotice);
            Assert.Equal(plan.Solution.Explanation,r.Explanation);Assert.Equal(plan.Solution.Steps,r.Steps);
            Assert.Equal(plan.Apply(r).UsageSummary,r.UsageSummary);
        }
    }
    [Fact]public void UnsupportedOrContradictoryInputsAreNeverReplacedWithSampleData(){Assert.Null(ReactionVariantPlan.Create(new(){Title="다른 문제",Body="NaOH 가열 농도"}));Assert.Throws<InvalidDataException>(()=>ReactionVariantPlan.Create(new(){Title="모순",Body=Source.Replace("A (10/3)w","A 5w")}));Assert.Null(ReactionVariantPlan.Create(new(){Title="풀이",Body=Source,FromSolution=true}));Assert.Throws<InvalidDataException>(()=>ReactionVariantPlan.Create(new(){Title="물질량",Body=Source.Replace("몰질량","물질량")}));}
    [Fact]public void CombinedMaterialKeepsLimitingReactantInferenceAndChecksOriginalAnswer(){
        var draft=new ProblemDraft{Title="문제+풀이",Body=Source,UseSolutionLogic=true,Answer="② (2)/(5)",Explanation="A가 모두 반응하면 실험 I와 II의 소비 질량비가 달라 모순이다. 따라서 B가 모두 반응한다.",Steps=["한계 반응물 가정과 모순 확인","반응 후 질량과 몰수 정리","상댓값·계수·몰질량 계산"]};
        var plan=ReactionVariantPlan.Create(draft)!;
        Assert.Contains("| A ",plan.Body);Assert.Contains("| B ",plan.Body);
        Assert.Equal(3,plan.Solution.B);Assert.Equal(15,plan.Solution.X,7);Assert.Equal("2/5",plan.Solution.Answer);
        Assert.Contains("STEP 1",plan.Solution.Steps[0]);Assert.Contains("상댓값",plan.Body);Assert.Contains("실제 몰분율",plan.Solution.Explanation);Assert.Contains("k = 45",plan.Solution.Explanation);
        Assert.Throws<InvalidDataException>(()=>ReactionVariantPlan.Create(draft with{Answer="① 1/5"}));
    }
    [Fact]public async Task ParenthesizedOcrQuantityMisreadingStopsBothModelsBeforeAnyRequest(){
        var draft=new ProblemDraft{Title="원본 전사",Body=Source.Replace("(b/x)","(b)/(x)").Replace("몰질량","물질량")};
        Assert.True(ReactionMassCheck.NeedsQuantityReview(draft.Body));using var http=new HttpClient(new RejectCalls());
        await Assert.ThrowsAsync<InvalidDataException>(()=>new LocalGemmaGenerator(http).GenerateAsync(draft,LocalGemmaGenerator.DefaultEndpoint));
        await Assert.ThrowsAsync<InvalidDataException>(()=>new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only"));
    }
    [Fact]public async Task CodeFailureMarksUncalledChecksAsSkippedWithoutModelRequest(){var draft=new ProblemDraft{Title="모순",Body="입력"};var r=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"문항",Source.Replace("A (10/3)w","A 5w"),["1","2","3","4","5"],"② 2","풀이",["a","b","c"],"변형");using var http=new HttpClient(new RejectCalls());var reviewed=await new QualityReviewClient(http).ReviewTextAsync(r,draft,"gemma","http://127.0.0.1:8092/v1","test",null);Assert.Equal("fail",reviewed.Quality!.State);Assert.Contains(reviewed.Quality.Checks,c=>c.Id=="language"&&c.State=="skipped");Assert.DoesNotContain(reviewed.Quality.Checks,c=>c.Evidence=="별도 AI 검토 대기");Assert.False(reviewed.Quality.CanExport);}
    [Theory][InlineData("gemma")][InlineData("deepseek")]public async Task GeneratorUsesVerifiedPlanWhenModelInventsContradictoryNumbers(string provider){var draft=new ProblemDraft{Title="반응량",Body=Source,UseSolutionLogic=true,Answer="② 2/5",Explanation="A가 모두 반응하면 소비 질량비가 달라 모순이다. 따라서 B가 모두 반응한다.",Steps=["한계 반응물 가정과 모순 확인","반응 후 질량과 몰수 정리","상댓값·계수·몰질량 계산"]};using var http=new HttpClient(new PlanHandler(draft));var r=provider=="gemma"?await new LocalGemmaGenerator(http).GenerateAsync(draft,LocalGemmaGenerator.DefaultEndpoint):await new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only");Assert.Equal("pass",ReactionMassCheck.InspectMassConditions(r.Body)!.State);Assert.Equal(r.Answer,ReactionMassCheck.Verify(r).Answer);Assert.EndsWith(draft.Body,r.SourceProblem);Assert.Contains(ReactionVariantPlan.Version,r.UsageSummary);Assert.DoesNotContain("A 5w | x",r.Body);}
    private sealed class PlanHandler(ProblemDraft draft):HttpMessageHandler{
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t){
            if(r.Method==HttpMethod.Get)return Reply(new{data=new[]{new{id="gemma-4-12b"}}});
            using var payload=System.Text.Json.JsonDocument.Parse(await r.Content!.ReadAsStringAsync(t));
            using var source=System.Text.Json.JsonDocument.Parse(payload.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!);Assert.NotEqual(System.Text.Json.JsonValueKind.Null,source.RootElement.GetProperty("verifiedPlan").ValueKind);
            Assert.Equal("problem-and-solution",source.RootElement.GetProperty("materialKind").GetString());Assert.Equal(draft.Explanation,source.RootElement.GetProperty("suppliedExplanation").GetString());Assert.Equal(draft.Steps,source.RootElement.GetProperty("suppliedSteps").EnumerateArray().Select(x=>x.GetString()).ToArray());
            var variant=new{status="ready",message="",inputFingerprint=draft.Fingerprint(),sourceLocation="사용자 기준 문제",title="변형",body=Source.Replace("A (10/3)w","A 5w"),choices=new[]{"1","2","3","4","5"},answerText="2",explanation="잘못된 계산",steps=new[]{"a","b","c"},changeSummary="수치 변경",graph=(object?)null,diagrams=Array.Empty<object>(),drawings=Array.Empty<object>(),visualRequirement="none"};
            return Reply(new{choices=new[]{new{finish_reason="stop",message=new{content=System.Text.Json.JsonSerializer.Serialize(variant)}}}});
        }
        private static HttpResponseMessage Reply(object value)=>new(System.Net.HttpStatusCode.OK){Content=new StringContent(System.Text.Json.JsonSerializer.Serialize(value))};
    }
    private sealed class RejectCalls:HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t)=>throw new Exception("No model request permitted");}
}
