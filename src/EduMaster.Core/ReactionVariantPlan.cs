using System.Security.Cryptography;
using System.Text;
namespace EduMaster.Core;

// Supported input only. Numbers are calculated from this draft, never from a cached sample.
public sealed record ReactionVariantPlan(string Body,string[] Choices,string Answer,ReactionMassSolution Solution,int MassScale)
{
    public const string Version="reaction-mass-plan-v4-verified-explanation-concise-steps";
    public static ReactionVariantPlan? Create(ProblemDraft draft)
    {
        if(draft.FromSolution||ScientificVisuals.NeedsVisuals(draft.Body))return null;
        if(ReactionMassCheck.NeedsQuantityReview(draft.Body))throw new InvalidDataException("이미지에서 ‘몰질량’과 ‘물질량’이 혼동됐습니다. 기준 문제와 해설을 원본에 대조해 용어를 확인해 주세요. 임의로 질문을 바꾸어 생성하지 않습니다.");
        try{
            var original=ReactionMassCheck.Solve(draft.Body);
            if(original is null)return null;
            if(!string.IsNullOrWhiteSpace(draft.Answer)){
                if(!ReactionMassCheck.ReferenceAnswerMatches(draft.Answer,original))throw new InvalidDataException($"원본 정답({draft.Answer})과 코드 검산({original.Answer})이 다릅니다. 문제·풀이 전사를 원본과 대조해 주세요.");
            }
            var seed=SHA256.HashData(Encoding.UTF8.GetBytes(draft.Fingerprint()));var scale=2+seed[0]%4;
            var body=ReactionMassCheck.UniformMassVariantBody(draft.Body,scale,false);
            var solution=ReactionMassCheck.Solve(body)!;
            var values=new[]{.5,1,1.5,2,2.5}.Select(f=>ReactionMassCheck.FormatValue(solution.Value*f)).ToArray();
            var offset=seed[1]%5;var choices=Enumerable.Range(0,5).Select(i=>values[(i+offset)%5]).ToArray();
            var correct=Array.IndexOf(choices,solution.Answer);
            if(correct<0||choices.Distinct().Count()!=5)return null;
            return new(body,choices,"①②③④⑤"[correct]+" "+choices[correct],solution,scale);
        }catch(InvalidDataException e){throw new InvalidDataException("원본 반응량 문제를 검산하지 못했습니다: "+e.Message,e);}
    }
    public SampleResult Apply(SampleResult result)=>result with{
        Body=Body,Choices=Choices,Answer=Answer,
        Explanation=Solution.Explanation,Steps=Solution.Steps,
        ChangeSummary=$"원본의 모든 반응 전·후 질량을 {MassScale}배로 변형하고 상대 몰비·잔류 화학종·물질의 관계를 유지했으며 보기 순서를 바꾸었습니다.",
        GenerationNotice=$"{result.Model} 문장 초안 + 코드 반응량 템플릿 재구성·독립 검산 · 교사 확인 전",
        UsageSummary=result.UsageSummary.Contains(Version)?result.UsageSummary:result.UsageSummary+" · "+Version,
        Graph=null,Diagrams=[],Drawings=[],VisualTemplates=[],RequiresVisuals=false,
        Figures=[],VisualVerification="원본에서 분리한 문제·풀이의 반응량 수치와 표는 코드로 검산·재구성했습니다. 이 유형은 표만 사용하며 별도의 그림 관계 검사를 하지 않습니다. 원본 이미지는 입력 대조 자료입니다."
    };
}
