namespace EduMaster.Core;

public sealed record LearningStage(int Number,int Total,string Label,ProblemDraft Draft);

public static class LearningStagePlan
{
    public static LearningStage[] Build(ProblemDraft source)
    {
        source.Validate();
        if(!source.UseSolutionLogic||source.Steps.Length<1)throw new ArgumentException("분석된 풀이 단계가 있어야 단계별 문제를 만들 수 있습니다.");
        var total=source.Steps.Length;
        return Enumerable.Range(1,total).Select(number=>{
            var steps=source.Steps.Take(number).ToArray();
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
                LogicScope=scope,
                SkipDeterministicPlan=!final
            };
            draft.Validate();
            return new LearningStage(number,total,label,draft);
        }).ToArray();
    }
}
