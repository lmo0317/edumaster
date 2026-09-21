using System.Text.Json;
using System.Text.RegularExpressions;
namespace EduMaster.Core;

// One image may contain both the printed question and the worked solution.
// Keep them separate so handwritten answers cannot become question conditions.
public sealed record ProblemSolutionMaterial(string Body,string Answer,string Explanation,string[] Steps,string[] Uncertainties)
{
    public static string ViewLabel(VisualPage page)=>page.MaterialRole switch{
        "question"=>"다음 이미지는 문제 영역입니다. body는 이 이미지의 인쇄된 문제·표·보기만 읽으세요. 파란 필기와 상단 정답 표시는 풀이 주석이며 조건이 아닙니다.",
        "solution"=>"다음 이미지는 풀이 영역입니다. answer, explanation, steps에만 사용하세요. 풀이 표의 실험값·추가 열이나 계산한 답을 body에 추가하지 마세요.",
        _=>""
    };
    public static ProblemSolutionMaterial Parse(string text)
    {
        try{
            text=ExtractJsonObject(text);
            using var json=JsonDocument.Parse(text);var r=json.RootElement;
            string ReadElement(JsonElement value)
            {
                if(value.ValueKind==JsonValueKind.String)return LocalVisionReader.NormalizeMath(value.GetString()??"");
                if(value.ValueKind==JsonValueKind.Object){
                    var preferred=new[]{"title","label","name","step","content","description","explanation","text","detail","message","reason"};
                    var values=preferred.Select(key=>value.TryGetProperty(key,out var property)&&property.ValueKind==JsonValueKind.String?LocalVisionReader.NormalizeMath(property.GetString()??""):"")
                        .Where(x=>!string.IsNullOrWhiteSpace(x)).Distinct().ToArray();
                    if(values.Length==0)values=value.EnumerateObject().Where(p=>p.Value.ValueKind==JsonValueKind.String).Select(p=>LocalVisionReader.NormalizeMath(p.Value.GetString()??"")).Where(x=>!string.IsNullOrWhiteSpace(x)).Distinct().ToArray();
                    return string.Join(" · ",values);
                }
                return "";
            }
            string Read(string key)=>ReadElement(r.GetProperty(key));
            string[] Array(string key)=>r.GetProperty(key).EnumerateArray().Select(ReadElement).ToArray();
            var rawSteps=Array("steps");
            var steps=LearningStepConsolidator.Consolidate(rawSteps);
            var uncertainties=Array("uncertainties");
            if(rawSteps.Length>steps.Length)uncertainties=uncertainties.Concat([$"이미지 판독 결과의 세부 계산 {rawSteps.Length}개를 순서와 내용을 유지한 채 {steps.Length}개의 큰 학습 단계로 묶었습니다."]).ToArray();
            var result=new ProblemSolutionMaterial(Read("body"),Read("answer"),Read("explanation"),steps,uncertainties);
            if(result.Body.Length<20||result.Body.Length>12000||result.Explanation.Length<20||result.Explanation.Length>12000||result.Answer.Length>3000||result.Steps.Length is < ProblemDraft.MinLogicSteps or > ProblemDraft.MaxLogicSteps||result.Steps.Any(string.IsNullOrWhiteSpace)||result.Steps.Any(s=>s.Length>3000)||result.Uncertainties.Length>20)
                throw new InvalidDataException("문제와 풀이를 모두 읽지 못했습니다. 문제·정답·풀이가 함께 보이는 선명한 이미지 한 장을 넣어 주세요.");
            if(Regex.Matches(result.Body,@":-{3,}").Count>24||result.Body.Count(c=>c=='|')>160)
                throw new InvalidDataException("이미지 모델이 표 구조를 반복하여 본문이 깨졌습니다. 다른 이미지 판독 모델로 다시 읽어 주세요.");
            return result;
        }catch(Exception e)when(e is JsonException or InvalidOperationException or KeyNotFoundException){throw new InvalidDataException("문제·풀이 분리 응답을 읽지 못했습니다. 원본 이미지를 확인해 주세요.",e);}
    }

    private static string ExtractJsonObject(string text)
    {
        text=(text??"").Trim();
        if(text.StartsWith("```",StringComparison.Ordinal)){
            var firstLine=text.IndexOf('\n');var closing=text.LastIndexOf("```",StringComparison.Ordinal);
            if(firstLine>=0&&closing>firstLine)text=text[(firstLine+1)..closing].Trim();
        }
        if(!text.StartsWith('{')||!text.EndsWith('}')){
            var start=text.IndexOf('{');var end=text.LastIndexOf('}');
            if(start>=0&&end>start)text=text[start..(end+1)];
        }
        return text;
    }

    public ProblemSolutionMaterial WithVerifiedLogic()
    {
        var normalizedBody=ReactionMassCheck.NormalizeSupportedOcr(Body);
        var quantityRepaired=false;
        if(ReactionMassCheck.NeedsQuantityReview(normalizedBody)){
            var candidate=ReactionMassCheck.RepairMolarMassOcr(normalizedBody);
            var candidateSolution=ReactionMassCheck.Solve(candidate);
            if(candidateSolution is not null&&ReactionMassCheck.ReferenceAnswerMatches(Answer,candidateSolution)){
                normalizedBody=candidate;quantityRepaired=true;
            }else throw new InvalidDataException("원본의 몰질량을 물질량으로 읽었을 가능성이 있지만 정답과 독립 계산이 일치하지 않습니다. 원본 이미지를 확인해 주세요.");
        }
        var verified=ReactionMassCheck.Solve(normalizedBody);
        if(verified is null){
            if(AcidBaseMixtureCheck.SolveSource(normalizedBody) is { } neutralization){
                return this with{
                    Body=normalizedBody,Answer=neutralization.Answer,Explanation=neutralization.Explanation,Steps=neutralization.Steps,
                    Uncertainties=Uncertainties.Concat(["산·염기 혼합 문제의 원본 정답과 풀이를 표의 이온 수·전하 균형으로 독립 검산해 교정했습니다."]).Distinct().ToArray()
                };
            }
            return GasMixtureAtomCheck.VerifySource(this)??this;
        }
        if(!ReactionMassCheck.ReferenceAnswerMatches(Answer,verified))
            throw new InvalidDataException($"풀이 이미지의 정답({Answer})과 문제 조건의 독립 검산({verified.Answer})이 다릅니다. 문제와 풀이 이미지를 다시 확인해 주세요.");
        // This narrow, code-supported reaction-quantity source has three printed STEP
        // blocks. Vision models have returned 3, 4 and 6 items for the same image by
        // promoting a final substitution or an equation to a new step. Once the source
        // has matched this verified type, use the independently calculated three blocks
        // instead of trusting that unstable segmentation. Other problem types never enter
        // this branch and retain their actual number of source steps.
        var segmentationChanged=Steps.Length!=verified.Steps.Length;
        return this with{
            Body=normalizedBody,
            Explanation=verified.Explanation,
            Steps=verified.Steps,
            Uncertainties=Uncertainties.Concat([quantityRepaired
                ?"이미지에서 물질량으로 읽힌 최종 비를 몰질량으로 교정했고, 원본 정답과 독립 계산이 일치함을 확인했습니다."
                :segmentationChanged
                ?$"이미지 모델이 풀이를 {Steps.Length}개의 세부 계산으로 나눴지만, 이 검산 지원 원본의 큰 STEP 구조에 맞춰 3단계로 다시 묶었습니다."
                :"지원 반응량 유형의 3개 STEP은 문제 조건으로 독립 계산하여 변수·수치와 논리 순서를 교정했습니다."]).Distinct().ToArray()
        };
    }
}
