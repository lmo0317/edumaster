namespace EduMaster.Core;

public sealed record LearningStage(int Number,int Total,string Label,ProblemDraft Draft);

public static class LearningStagePlan
{
    public const string GenerationRules="""
[단계별 연습 문제 필수 규칙]
logicScope가 비어 있지 않으면 suppliedSteps에 포함된 풀이 단계만 연습하는 독립 문제를 만든다.
1. 생성된 steps는 suppliedSteps의 같은 번호와 같은 판단·비교·계산을 반드시 수행해야 한다. 더 쉬운 다른 풀이로 바꾸지 않는다.
2. suppliedSteps가 여러 실험의 비교나 가정의 모순 검증을 요구하면 문제에도 그 비교가 필요하도록 원시 자료를 제공한다. 한 실험의 직접 정보만으로 결론 내리게 바꾸지 않는다.
3. 학생이 해당 단계에서 추론해야 하는 결론을 본문·표 제목·행 값·그림에 미리 쓰지 않는다. 예: 남은 물질의 종류, 한계 반응물, 미지 부호, 중간 계산값.
   문제의 질문에 '판별·추론·구하라'가 있으면 그 대상을 원시 자료에 정답 형태로 적지 않는다. 반응표에서 남은 물질의 종류를 추론하는 문제라면 잔류량 칸에 A 또는 B를 쓰지 말고 질량만 준다.
4. 마지막 suppliedStep의 결론을 질문하며, 이후 단계의 지식은 필요하지 않아야 한다.
5. 출력 전 문제만 보고 직접 풀어 각 suppliedStep이 빠짐없이 필요하고 정답이 유일한지 확인한다.
6. explanation은 허용된 각 STEP마다 사용 조건, 판단 이유, 수치 대입 전 식, 실제 계산과 단위, 단계 결론을 자세히 설명한다. 정답만 선언하거나 계산식을 생략하지 않는다.
""";
    public static LearningStage[] Build(ProblemDraft source)
    {
        source.Validate();
        if(!source.UseSolutionLogic||source.Steps.Length<1)throw new ArgumentException("분석된 풀이 단계가 있어야 단계별 문제를 만들 수 있습니다.");
        var total=source.Steps.Length;
        return Enumerable.Range(1,total).Select(number=>{
            var steps=source.Steps.Take(number).ToArray();
            var excluded=source.Steps.Skip(number).ToArray();
            var final=number==total;
            var label=final?"전체 로직 쌍둥이 문제":number==1?"STEP 1 연습 문제":$"STEP 1~{number} 누적 연습 문제";
            var scope=final
                ?$"최종 {number}/{total}단계 문제입니다. 기준 풀이의 STEP 1부터 STEP {total}까지 모두 같은 순서로 사용해야 풀리는 쌍둥이 문제 한 개를 만드세요."
                :$"중간 {number}/{total}단계 연습 문제입니다. 기준 풀이의 STEP 1부터 STEP {number}까지만 사용해야 풀리는 독립 문제 한 개를 만드세요. STEP {number+1} 이후의 판단이나 계산은 필요하지 않아야 합니다. 질문 목표는 STEP {number}에서 얻는 중간 결론이어야 합니다.";
            var draft=source with{
                Id=Guid.NewGuid(),
                Title=source.Title+" · "+label,
                Answer=final?source.Answer:"",
                Explanation=string.Join("\n",steps),
                Steps=steps,
                ExcludedSteps=excluded,
                LogicScope=scope,
                SkipDeterministicPlan=!final
            };
            draft.Validate();
            return new LearningStage(number,total,label,draft);
        }).ToArray();
    }
    public static SampleResult RepairExposedConclusion(SampleResult result,ProblemDraft draft)
        =>RepairExposedConclusion(result,draft.Steps,draft.SkipDeterministicPlan);
    public static SampleResult RepairExposedConclusion(SampleResult result,IEnumerable<string> allowedSteps,bool partialStage)
    {
        if(!partialStage||!allowedSteps.Any(s=>s.Contains("한계 반응물")||s.Contains("남는 기체")||s.Contains("잔류 물질"))||!ReactionMassCheck.TryHideRemainingSpecies(result.Body,out var body,out var proof))return result;
        var steps=result.Steps.ToArray();var oldFirst=steps.FirstOrDefault()??"";if(steps.Length>0)steps[0]=proof;
        var explanation=result.Explanation;if(oldFirst.Length>0&&explanation.Contains(oldFirst,StringComparison.Ordinal))explanation=explanation.Replace(oldFirst,proof,StringComparison.Ordinal);else explanation=proof+"\n\n"+explanation;
        return result with{Body=body,Steps=steps,Explanation=explanation,ChangeSummary=result.ChangeSummary+" · 표의 잔류 기체 종류는 학생이 추론하도록 숨기고 공통 소비 질량비로 유일성을 코드 검산함"};
    }
}
