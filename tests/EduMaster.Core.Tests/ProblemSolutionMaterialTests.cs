using EduMaster.Core;
using System.Text.Json;
namespace EduMaster.Core.Tests;
public class ProblemSolutionMaterialTests
{
    [Theory]
    [InlineData("```json\n{0}\n```")]
    [InlineData("분석 결과입니다.\n{0}\n확인해 주세요.")]
    public void ReaderAcceptsJsonWrappedByModelFormatting(string wrapper){
        var json=JsonSerializer.Serialize(new{body=ReactionVariantPlanTests.Source,answer="② 2/5",explanation="문제 조건에서 한계 반응물을 판단하고 질량과 몰수 관계를 계산하여 정답을 구한다.",steps=new[]{"한계 반응물 판단","질량·몰수 정리","상댓값 계산"},uncertainties=Array.Empty<string>()});
        var material=ProblemSolutionMaterial.Parse(string.Format(wrapper,json));
        Assert.Equal(3,material.Steps.Length);Assert.Equal("② 2/5",material.Answer);
    }
    [Fact]public void ReaderRejectsRunawayMarkdownTableInsteadOfAcceptingTruncatedQuestion(){
        var broken="문제 본문과 표입니다.\n| 열 | 값 |\n|"+string.Join("|",Enumerable.Repeat(":---",40))+"|";
        var json=JsonSerializer.Serialize(new{body=broken,answer="② 2/5",explanation="표를 읽는 과정에서 구분선이 반복되어 실제 조건과 질문이 잘린 잘못된 응답입니다.",steps=new[]{"판단","계산","결론"},uncertainties=Array.Empty<string>()});
        var error=Assert.Throws<InvalidDataException>(()=>ProblemSolutionMaterial.Parse(json));
        Assert.Contains("표 구조를 반복",error.Message);
    }
    [Fact]public void ReaderAcceptsObjectShapedStepsAndUncertainties(){
        var json=JsonSerializer.Serialize(new{body=ReactionVariantPlanTests.Source,answer="② 2/5",explanation="문제 조건에서 세 개의 큰 풀이 단계로 계산하여 정답을 구하는 충분히 긴 해설이다.",steps=new object[]{new{title="STEP 1",content="한계 반응물을 판별한다"},new{name="STEP 2",description="반응 후 질량과 몰수를 구한다"},new{label="STEP 3",text="상댓값과 몰질량 관계로 답을 구한다"}},uncertainties=new object[]{new{message="일부 필기는 문제 조건에서 제외했다"}}});
        var material=ProblemSolutionMaterial.Parse(json);
        Assert.Equal(3,material.Steps.Length);
        Assert.Equal("STEP 1 · 한계 반응물을 판별한다",material.Steps[0]);
        Assert.Equal("일부 필기는 문제 조건에서 제외했다",material.Uncertainties[0]);
    }
    [Fact]public void LearningSeriesUsesActualStepCountAndCumulativePrefixes(){
        var source=new ProblemDraft{Title="기준 문제",Body=ReactionVariantPlanTests.Source,Answer="② 2/5",Explanation="전체 해설",Steps=["첫 판단","두 번째 계산","세 번째 결론","최종 검산"],UseSolutionLogic=true};
        var stages=LearningStagePlan.Build(source);
        Assert.Equal(4,stages.Length);Assert.Equal([1,2,3,4],stages.Select(x=>x.Draft.Steps.Length));
        Assert.All(stages.Take(3),x=>Assert.True(x.Draft.SkipDeterministicPlan));Assert.False(stages[^1].Draft.SkipDeterministicPlan);
        Assert.Contains("STEP 1~3",stages[2].Label);Assert.Equal(source.Answer,stages[^1].Draft.Answer);Assert.Empty(stages[0].Draft.Answer);
        Assert.Equal(["두 번째 계산","세 번째 결론","최종 검산"],stages[0].Draft.ExcludedSteps);
        Assert.Equal(["최종 검산"],stages[2].Draft.ExcludedSteps);Assert.Empty(stages[^1].Draft.ExcludedSteps);
        Assert.Contains("잔류량 칸에 A 또는 B를 쓰지",LearningStagePlan.GenerationRules);
    }
    [Fact]public void ReaderSeparatesQuestionAndSolutionWithoutPromotingAnswerToCondition(){
        var material=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body=ReactionVariantPlanTests.Source,answer="② (2)/(5)",explanation="원본 풀이: A가 모두 반응했다고 가정하면 실험별 소비 질량비가 달라 모순이다. B가 모두 반응한다.",steps=new[]{"가정과 모순으로 한계 반응물 판단","반응 후 질량·몰수 정리","공통 상댓값 배율·계수·몰질량으로 계산"},uncertainties=Array.Empty<string>()}));
        Assert.DoesNotContain("x=15",material.Body);Assert.Contains("모순",material.Explanation);Assert.Equal(3,material.Steps.Length);
        Assert.Equal("② (2)/(5)",material.Answer);
    }
    [Fact]public void MissingSolutionAndMissingLogicAreRejected(){
        Assert.Throws<InvalidDataException>(()=>ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body=ReactionVariantPlanTests.Source,answer="",explanation="",steps=new[]{"","",""},uncertainties=Array.Empty<string>()})));
        Assert.Throws<ArgumentException>(()=>new ProblemDraft{Title="문제+풀이",Body=ReactionVariantPlanTests.Source,UseSolutionLogic=true}.Validate());
        Assert.Throws<ArgumentException>(()=>new ProblemDraft{Title="문제+풀이",Body=ReactionVariantPlanTests.Source,Explanation="해설은 있음",Steps=["첫 단계","", "세 번째 단계"],UseSolutionLogic=true}.Validate());
        new ProblemDraft{Title="문제+풀이",Body=ReactionVariantPlanTests.Source,Explanation="해설",Steps=["가정","계산","검산"],UseSolutionLogic=true}.Validate();
    }
    [Fact]public void SupportedReactionReplacesIncorrectThreeStepVisionLogic(){
        var read=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body=ReactionVariantPlanTests.Source,answer="② 2/5",explanation="I에서는 B가 한계지만 II에서는 A가 한계라고 잘못 판독한 긴 풀이 설명입니다.",steps=new[]{"I에서는 B, II에서는 A가 한계", "질량과 몰수", "상댓값 계산"},uncertainties=Array.Empty<string>()}));
        var verified=read.WithVerifiedLogic();
        Assert.Equal(ReactionMassCheck.Solve(ReactionVariantPlanTests.Source)!.Steps,verified.Steps);
        Assert.Equal(ReactionMassCheck.Solve(ReactionVariantPlanTests.Source)!.Explanation,verified.Explanation);
        Assert.DoesNotContain("II에서는 A가 한계",verified.Explanation);
        Assert.Contains("M_A/M_B = b/3",verified.Explanation);
        Assert.Contains("b = 3",verified.Explanation);
        Assert.Contains(verified.Uncertainties,x=>x.Contains("독립 계산")&&x.Contains("교정"));
    }
    [Fact]public void ReaderAndDraftPreserveAnActualFourStepSolution(){
        var steps=new[]{"식을 세운다","첫 관계를 계산한다","두 번째 조건과 결합한다","원문 조건에 대입해 답을 검산한다"};
        var body="네 개의 서로 다른 조건을 순서대로 적용하여 미지수의 값을 구하는 일반 수학 문제이다. 각 조건은 다음 조건을 계산하는 데 필요하다.";
        var material=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body,answer="② 2",explanation="원본 풀이가 네 개의 구분된 판단과 계산 단계로 작성되어 있으며 마지막에 조건을 대입해 검산한다.",steps,uncertainties=Array.Empty<string>()}));
        Assert.Equal(4,material.Steps.Length);
        var verified=material.WithVerifiedLogic();Assert.Equal(steps,verified.Steps);
        new ProblemDraft{Title="4단계 기준",Body=verified.Body,Answer=verified.Answer,Explanation=verified.Explanation,Steps=verified.Steps,UseSolutionLogic=true}.Validate();
    }
    [Fact]public void ReaderConsolidatesElevenMicroStepsIntoAtMostSixLearningStages(){
        var steps=Enumerable.Range(1,11).Select(number=>$"세부 계산 {number}").ToArray();
        var body="여러 조건과 계산식을 차례로 적용해 하나의 값을 구하는 일반 과학 문제이며, 제시된 풀이에는 계산식이 세부 줄로 나뉘어 있다.";
        var material=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body,answer="③ 7",explanation="조건을 확인한 뒤 여러 식을 순서대로 계산하고 마지막에 원래 조건에 대입하여 정답을 검산하는 상세한 풀이이다.",steps,uncertainties=Array.Empty<string>()}));
        Assert.Equal(ProblemDraft.MaxLogicSteps,material.Steps.Length);
        Assert.Contains("세부 계산 1",material.Steps[0]);Assert.Contains("세부 계산 11",material.Steps[^1]);
        Assert.Contains(material.Uncertainties,item=>item.Contains("11개")&&item.Contains("6개의 큰 학습 단계"));
    }
    [Fact]public void SupportedThreeStepReactionCollapsesASeparateFinalSubstitution(){
        var splitSteps=new[]{"한계 반응물 판별","반응 후 질량과 몰수","상댓값과 반응계수 계산","최종 식에 수치를 대입"};
        var read=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body=ReactionVariantPlanTests.Source,answer="② 2/5",explanation="원본의 세 번째 큰 STEP에 속한 최종 대입을 별도 단계로 잘못 분리한 풀이입니다.",steps=splitSteps,uncertainties=Array.Empty<string>()}));
        var verified=read.WithVerifiedLogic();
        Assert.Equal(3,verified.Steps.Length);
        Assert.Contains(verified.Uncertainties,x=>x.Contains("4개의 세부 계산")&&x.Contains("3단계"));
    }
    [Fact]public void SupportedThreeStepReactionCollapsesVisionMicroSteps(){
        var microSteps=new[]{"한계 반응물을 가정한다","가정의 모순을 확인한다","반응 후 질량을 구한다","몰수를 구한다","상댓값을 구한다","몰질량 관계로 답을 구한다"};
        var read=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body=ReactionVariantPlanTests.Source,answer="② 2/5",explanation="원본의 STEP 1부터 STEP 3까지를 식 단위로 잘못 쪼갠 긴 풀이 설명입니다.",steps=microSteps,uncertainties=Array.Empty<string>()}));
        var verified=read.WithVerifiedLogic();
        Assert.Equal(3,verified.Steps.Length);
        Assert.All(verified.Steps,(step,index)=>Assert.StartsWith($"STEP {index+1}",step));
        Assert.Contains(verified.Uncertainties,x=>x.Contains("6개의 세부 계산")&&x.Contains("3단계"));
    }
    [Fact]public void SupportedReactionRejectsSolutionImageWithWrongAnswer(){
        var read=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body=ReactionVariantPlanTests.Source,answer="① 1/5",explanation="풀이 이미지에서 길게 읽은 설명이지만 정답이 문제 조건과 맞지 않습니다.",steps=new[]{"한계 반응물", "질량과 몰수", "상댓값 계산"},uncertainties=Array.Empty<string>()}));
        Assert.Throws<InvalidDataException>(()=>read.WithVerifiedLogic());
    }
    [Fact]public void SupportedReactionRepairsMolarMassOcrBeforeVerifyingTheSolution(){
        var ocr=ReactionVariantPlanTests.Source.Replace("C의 몰질량 + D의 몰질량","C의 질량 + D의 질량").Replace("B의 몰질량","B의 질량");
        var read=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body=ocr,answer="② 2/5",explanation="풀이에서는 각 기체의 몰질량 관계를 사용하여 최종값을 계산한다.",steps=new[]{"한계 반응물", "질량과 몰수", "몰질량 관계"},uncertainties=Array.Empty<string>()}));
        var verified=read.WithVerifiedLogic();
        Assert.Contains("C의 몰질량 + D의 몰질량",verified.Body);
        Assert.Equal("2/5",ReactionMassCheck.Solve(verified.Body)!.Answer);
    }
    [Fact]public void SupportedReactionRepairsMolarAmountOcrOnlyWhenTheReferenceAnswerMatches(){
        var ocr=ReactionVariantPlanTests.Source.Replace("C의 몰질량 + D의 몰질량","C의 물질량 + D의 물질량").Replace("B의 몰질량","B의 물질량").Replace("| x |","| x = 15 |");
        var read=ProblemSolutionMaterial.Parse(JsonSerializer.Serialize(new{body=ocr,answer="② 2/5",explanation="풀이 이미지에서 최종 비와 표의 필기 값을 함께 읽은 상세한 해설입니다.",steps=new[]{"한계 반응물","질량과 몰수","몰질량 관계"},uncertainties=Array.Empty<string>()}));
        var verified=read.WithVerifiedLogic();
        Assert.Contains("C의 몰질량 + D의 몰질량",verified.Body);
        Assert.DoesNotContain("x = 15",verified.Body);
        Assert.Contains(verified.Uncertainties,x=>x.Contains("몰질량으로 교정"));
        Assert.Throws<InvalidDataException>(()=>(read with{Answer="① 1/5"}).WithVerifiedLogic());
    }
    [Fact]public void HarnessExposesTheReferenceLogicLink(){
        var draft=new ProblemDraft{Title="기준 문제",Body=ReactionVariantPlanTests.Source,Explanation="해설",Steps=["가정","계산 1","계산 2","검산"],UseSolutionLogic=true};
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"응용 문제",ReactionVariantPlanTests.Source,["1","2","3","4","5"],"① 1","풀이",["가정 적용","계산 1 적용","계산 2 적용","검산 적용"],"변형"){SourceSteps=draft.Steps};
        Assert.Contains(ProblemQualityHarness.Inspect(result,draft).Checks,c=>c.Id=="source-logic"&&c.State=="pass");
    }
    [Fact]public void UndefinedResidueGasIsInferredFromAllThreeExperiments(){
        var text=ReactionVariantPlanTests.Source.Replace("A (10/3)w","(10/3)w").Replace("A 2w","2w").Replace("B w","w");
        var solution=ReactionMassCheck.Solve(text)!;
        Assert.Equal("2/5",solution.Answer);Assert.Contains("A, A, B",solution.Steps[0]);
        Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.Solve(text.Replace("| 5w | 5w |","| 3w | 3w |")));
    }
    [Fact]public void SourceStructureDriftIsCaughtWithoutAI(){
        var draft=new ProblemDraft{Title="기준 문제",Body=ReactionVariantPlanTests.Source};
        var bad=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"틀린 변형",draft.Body.Replace("bB(g)","3B(g)").Replace("몰질량","질량"),["1","2","3","4","5"],"① 1","풀이",["1","2","3"],"변형");
        Assert.Contains(ProblemQualityHarness.Inspect(bad,draft).Checks,c=>c.Id=="source-reaction-type"&&c.State=="fail");
    }
    [Fact]public void MolesInTableHeadingDoNotChangeMolarMassQuestion(){
        var source=ReactionVariantPlanTests.Source.Replace("D의 양/전체 기체의 양 (상댓값)","D의 물질량/전체 기체의 물질량 (상대값)");
        Assert.False(ReactionMassCheck.NeedsQuantityReview(source));
        Assert.NotNull(ReactionVariantPlan.Create(new(){Title="동치 표기",Body=source,Answer="② 0.4"}));
    }
    [Fact]public void AsciiReactionArrowAndParenthesizedFractionsKeepTheSameChemistry(){
        var source=ReactionVariantPlanTests.Source.Replace("→","->").Replace("(b/x)","(b)/(x)");
        Assert.Equal("2/5",ReactionMassCheck.Solve(source)!.Answer);
    }
    [Theory][InlineData("deepseek")][InlineData("gemma")]public async Task MaterialReaderUsesSelectedModelsImageInput(string provider){
        using var http=new HttpClient(new MaterialHandler(provider));var page=new VisualPage([1,2,3],"image/png",1);
        var material=provider=="deepseek"?await new DeepSeekVisualGenerator(http).ReadMaterialAsync(page,"test-only"):await new LocalVisionReader(http).ReadMaterialAsync(page,endpoint:LocalGemmaGenerator.DefaultEndpoint,model:"edumaster-gemma-4-12b-vision");
        Assert.Contains("모순",material.Explanation);Assert.Equal("② 2/5",material.Answer);Assert.Equal(3,material.Steps.Length);
    }
    [Theory][InlineData("deepseek")][InlineData("gemma")]public async Task ProblemAndSolutionRegionsHaveExplicitRoles(string provider){
        using var http=new HttpClient(new MaterialHandler(provider,true));var page=new VisualPage([1,2,3],"image/png",1);
        var views=new[]{page with{MaterialRole="question"},page with{MaterialRole="solution"},page with{MaterialRole="solution"}};
        _=provider=="deepseek"?await new DeepSeekVisualGenerator(http).ReadMaterialAsync(page,"test-only",views:views):await new LocalVisionReader(http).ReadMaterialAsync(page,endpoint:LocalGemmaGenerator.DefaultEndpoint,model:"edumaster-gemma-4-12b-vision",views:views);
    }
    private sealed class MaterialHandler(string provider,bool annotated=false):HttpMessageHandler{
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){
            Assert.Equal(provider=="deepseek"?"api.deepseek.com":"127.0.0.1",request.RequestUri!.Host);
            using var payload=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal(provider=="deepseek"?DeepSeekVisualGenerator.Model:"edumaster-gemma-4-12b-vision",payload.RootElement.GetProperty("model").GetString());
            var content=payload.RootElement.GetProperty("messages")[0].GetProperty("content");Assert.Equal("image_url",content[annotated?2:1].GetProperty("type").GetString());
            if(annotated){Assert.Contains("문제 영역",content[1].GetProperty("text").GetString());Assert.Contains("풀이 영역",content[3].GetProperty("text").GetString());Assert.Equal(3,content.EnumerateArray().Count(p=>p.GetProperty("type").GetString()=="image_url"));}
            Assert.Contains("문제와 풀이",content[0].GetProperty("text").GetString());
            var material=new{body=ReactionVariantPlanTests.Source,answer="② 2/5",explanation="A가 모두 반응했다고 가정하면 소비 질량비가 달라 모순이다. B가 모두 반응한다.",steps=new[]{"한계 반응물 판단","질량·몰수 정리","상댓값과 몰질량 계산"},uncertainties=Array.Empty<string>()};
            return new(System.Net.HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new{choices=new[]{new{finish_reason="stop",message=new{content=JsonSerializer.Serialize(material)}}}}))};
        }
    }
}
