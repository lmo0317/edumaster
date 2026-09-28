using System.Text.Json;
using System.Text.RegularExpressions;
namespace EduMaster.Core;

// One image may contain both the printed question and the worked solution.
// Keep them separate so handwritten answers cannot become question conditions.
public sealed record ProblemSolutionMaterial(string Body,string Answer,string Explanation,string[] Steps,string[] Uncertainties)
{
    public bool UsedCodeRepair{get;init;}
    public static string ViewLabel(VisualPage page)=>(page.MaterialRole switch{
        "question"=>"다음 이미지는 문제 영역입니다. body는 이 이미지의 인쇄된 문제·표·보기만 읽으세요. 파란 필기와 상단 정답 표시는 풀이 주석이며 조건이 아닙니다.",
        "question-print"=>"다음 이미지는 바로 앞 문제 이미지의 인쇄 글자 판독용 보조 보기입니다. 색 필기를 밝게 처리했습니다. 검정 인쇄된 표 값과 물음표는 이 보기에서 확인하세요. 원본 컬러 이미지도 함께 제공되므로 실제 인쇄된 색 도형·라벨은 원본과 대조하세요. 필기로 채운 답·속도·지점 대응을 body에 넣지 않습니다.",
        "solution"=>"다음 이미지는 풀이 영역입니다. answer, explanation, steps에만 사용하세요. 풀이 표의 실험값·추가 열이나 계산한 답을 body에 추가하지 마세요.",
        _=>""
    })+(page.ReadingRegion.Length==0?"":"\n"+page.ReadingRegion);
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
        var literal=ExplanationConsistencyCheck.Inspect(new(Guid.NewGuid(),Guid.NewGuid(),"source","원본 판독",normalizedBody,[],Answer,Explanation,Steps,""),compareAnswer:false);
        if(literal?.State=="fail"){
            var error=new InvalidDataException("원본 문제·풀이 재판독 필요: "+literal.Evidence+" 값을 정답에 맞춰 고치지 말고 인쇄된 원본을 다시 읽어야 합니다.");
            error.Data["TeacherMethodReread"]=true;throw error;
        }
        var quantityRepaired=false;
        if(ReactionMassCheck.NeedsQuantityReview(normalizedBody)){
            var candidate=ReactionMassCheck.RepairMolarMassOcr(normalizedBody);
            var candidateSolution=ReactionMassCheck.Solve(candidate);
            if(candidateSolution is not null&&ReactionMassCheck.ReferenceAnswerMatches(Answer,candidateSolution,candidate)){
                normalizedBody=candidate;quantityRepaired=true;
            }else throw new InvalidDataException("원본의 몰질량을 물질량으로 읽었을 가능성이 있지만 정답과 독립 계산이 일치하지 않습니다. 원본 이미지를 확인해 주세요.");
        }
        var verified=ReactionMassCheck.Solve(normalizedBody);
        if(verified is null){
            if(AcidBaseMixtureCheck.SolveSource(normalizedBody) is { } neutralization){
                var source=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"source","입력 문제",normalizedBody,[],Answer,Explanation,Steps,"")
                    {SourceProblem=normalizedBody,SourceAnswer=Answer,SourceExplanation=Explanation};
                var check=AcidBaseMixtureCheck.InspectSource(source);
                if(check?.State=="fail")throw new InvalidDataException("풀이 이미지의 정답·판단과 원본 표가 맞지 않습니다. 원본 풀이를 확인해 주세요. "+check.Evidence);
                return this with{
                    Body=normalizedBody,Answer=string.IsNullOrWhiteSpace(Answer)?neutralization.Answer:Answer,
                    Uncertainties=Uncertainties.Concat(["정답은 이온 수·전하 균형으로 독립 검산했습니다. 이미지에서 읽은 선생님 풀이와 STEP은 자동 교체하지 않았으니 원본과 대조해 주세요."]).Distinct().ToArray()
                };
            }
            if(SequentialNeutralizationCheck.SolveSource(normalizedBody) is { } sequentialNeutralization){
                var source=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"source","입력 문제",normalizedBody,[],Answer,Explanation,Steps,"")
                    {SourceProblem=normalizedBody,SourceAnswer=Answer,SourceExplanation=Explanation};
                var check=SequentialNeutralizationCheck.InspectSource(source);
                if(check?.State=="fail")throw new InvalidDataException("풀이 이미지의 정답과 원본 조건이 맞지 않습니다. 원본 풀이를 확인해 주세요. "+check.Evidence);
                return this with{
                    Body=normalizedBody,Answer=string.IsNullOrWhiteSpace(Answer)?sequentialNeutralization.Answer:Answer,
                    Uncertainties=Uncertainties.Concat(["정답은 이온 수·농도로 독립 검산했습니다. 이미지에서 읽은 풀이와 STEP은 자동 교체하지 않았으니 원본과 대조해 주세요."]).Distinct().ToArray()
                };
            }
            var gasCheck=GasMixtureAtomCheck.VerifySource(this with{Body=normalizedBody});
            if(gasCheck is not null){
                static string? ZValue(string explanation){var match=Regex.Match(explanation,@"(?<![A-Za-z])z\s*=\s*\(?\s*(?<value>\d+(?:\s*/\s*\d+)?)\s*\)?\s*k(?<post>\s*/\s*\d+)?",RegexOptions.IgnoreCase);return match.Success?Regex.Replace(match.Groups["value"].Value+match.Groups["post"].Value,@"\s+",""):null;}
                var readZ=ZValue(Explanation);var verifiedZ=ZValue(gasCheck.Explanation);
                if(readZ is not null&&verifiedZ is not null&&readZ!=verifiedZ)throw new InvalidDataException($"풀이 이미지에서 읽은 z={readZ}k와 독립 계산 z={verifiedZ}k가 다릅니다. 원본의 문자 도입·중간값을 다시 확인해 주세요.");
            }
            return gasCheck is null?this with{Body=normalizedBody}:this with{Body=normalizedBody,
                Uncertainties=Uncertainties.Concat(["기체 혼합 정답은 표의 원자 수·질량으로 독립 검산했습니다. 이미지에서 읽은 풀이와 기호 도입 방식은 자동 교체하지 않았습니다."]).Distinct().ToArray()};
        }
        if(!ReactionMassCheck.ReferenceAnswerMatches(Answer,verified,normalizedBody))
            throw new InvalidDataException($"풀이 이미지의 정답({Answer})과 문제 조건의 독립 검산({verified.Answer})이 다릅니다. 문제와 풀이 이미지를 다시 확인해 주세요.");
        var segmentationChanged=Steps.Length!=verified.Steps.Length;
        var displayedAnswer=Regex.IsMatch(LocalVisionReader.NormalizeMath(Answer),@"^(?:정답\s*[:：]?\s*)?[①②③④⑤](?:번)?\s*$")
            ?Regex.Match(LocalVisionReader.NormalizeMath(Answer),@"[①②③④⑤]").Value+" "+verified.Answer:Answer;
        var contradiction=ReactionMassCheck.ReadSolutionContradiction(Explanation,Steps);
        var corruptedMolarMass=quantityRepaired&&Regex.IsMatch(Explanation,@"C의\s*물질량\s*\+\s*D의\s*물질량");
        if(contradiction is not null){
            var error=new InvalidDataException("원본 풀이 재판독 필요: "+contradiction+" 선생님 풀이를 코드 풀이로 대체하지 않습니다.");
            error.Data["TeacherMethodReread"]=true;
            throw error;
        }
        var teacherExplanation=corruptedMolarMass?Explanation.Replace("C의 물질량", "C의 몰질량").Replace("D의 물질량", "D의 몰질량").Replace("B의 물질량", "B의 몰질량"):Explanation;
        if(Math.Abs(verified.B/verified.MassRatio-1)<1e-9&&Regex.IsMatch(teacherExplanation,@"(?<![A-Za-z])m\s*=\s*n"))
            teacherExplanation=teacherExplanation.Replace("A의 물질량과 B의 몰질량", "A의 몰질량과 B의 몰질량");
        return this with{
            Body=normalizedBody,Answer=displayedAnswer,
            Explanation=teacherExplanation,
            Uncertainties=Uncertainties.Concat([quantityRepaired
                ?"이미지에서 물질량으로 읽힌 최종 비를 몰질량으로 교정했고, 원본 정답과 독립 계산이 일치함을 확인했습니다."
                :segmentationChanged
                ?$"이미지에서 읽은 풀이 {Steps.Length}단계와 코드 계산의 {verified.Steps.Length}단계가 다릅니다. 선생님 원본 STEP을 확인해 수정해 주세요. 풀이를 자동 교체하지 않았습니다."
                :"정답은 반응량으로 독립 검산했습니다. 이미지에서 읽은 선생님 풀이·기호 도입·STEP은 자동 교체하지 않았으니 원본과 대조해 주세요.",
                "코드 계산과 비교: "+verified.Steps[0]]).Distinct().ToArray()
        };
    }
}
