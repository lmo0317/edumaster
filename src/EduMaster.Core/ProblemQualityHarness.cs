using System.Text.RegularExpressions;
namespace EduMaster.Core;

public sealed record QualityCheck(string Id,string Label,string State,string Evidence,string Method);
public sealed record QualityReport(string Version,QualityCheck[] Checks)
{
    public string? RenderHash {get;init;}
    public string? RenderReviewVersion {get;init;}
    public string State=>Checks.Any(c=>c.State=="fail")?"fail":Checks.Any(c=>c.State!="pass")?"review_required":"pass";
    public bool CanExport=>State!="fail";
    public const string CurrentVersion="quality-harness-v1";
}

public static class ProblemQualityHarness
{
    public static QualityReport Inspect(SampleResult r,ProblemDraft? draft=null,bool partialLearningStage=false)
    {
        var checks=new List<QualityCheck>();
        void Add(string id,string label,bool ok,string evidence)=>checks.Add(new(id,label,ok?"pass":"fail",evidence,"code"));
        string Compact(string s)=>Regex.Replace(s,@"\s+","");
        partialLearningStage|=draft?.SkipDeterministicPlan==true;
        Add("structure","문항 필수 항목",!string.IsNullOrWhiteSpace(r.Body)&&!string.IsNullOrWhiteSpace(r.Explanation)&&r.Steps.Length is >= ProblemDraft.MinLogicSteps and <= ProblemDraft.MaxLogicSteps&&r.Steps.All(s=>!string.IsNullOrWhiteSpace(s)),"본문·해설·실제 풀이 단계 존재 여부");
        var referenceSteps=draft?.UseSolutionLogic==true?draft.Steps:r.SourceSteps;
        if(referenceSteps.Length>0)Add("source-logic","기준 풀이 로직 연결",referenceSteps.Length is >= ProblemDraft.MinLogicSteps and <= ProblemDraft.MaxLogicSteps&&referenceSteps.All(s=>!string.IsNullOrWhiteSpace(s))&&r.Steps.Length==referenceSteps.Length&&r.Steps.All(s=>!string.IsNullOrWhiteSpace(s)),"기준 풀이와 생성 풀이의 단계 수·순서 대응 여부. 의미 동일성은 AI 검토에서 대조");
        if(partialLearningStage&&referenceSteps.Any(s=>s.Contains("한계 반응물")||s.Contains("남는 기체")||s.Contains("잔류 물질"))){
            var revealsRemaining=r.Body.Split('\n').Any(line=>{
                var cells=line.Split('|',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries);
                return cells.Length>=4&&Regex.IsMatch(cells[0],@"^(I|II|III|Ⅰ|Ⅱ|Ⅲ)$")&&Regex.IsMatch(Compact(cells[3]),@"^[AB](?:\(?\d|w)");
            });
            Add("stage-clue-leak","단계 결론 단서 노출",!revealsRemaining,"한계 반응물·남는 물질을 추론하는 단계에서는 표의 잔류량 칸에 A/B 종류를 미리 쓰지 않는지 검사");
        }
        Add("choices","보기·정답 연결",r.Choices.Length==5&&r.Choices.All(s=>!string.IsNullOrWhiteSpace(s))&&r.Choices.Select(Compact).Distinct().Count()==5&&r.Choices.Count(c=>Compact(c)==Compact(Regex.Replace(r.Answer,@"^[①②③④⑤]\s*","")))==1,"보기 5개·중복 문자열·정답 문자열 연결 검사. 수학적 동치 보기는 별도 검토");
        if(draft is not null)Add("input","입력 연결",r.InputId==draft.Id&&r.InputFingerprint==draft.Fingerprint(),"생성 결과와 원래 입력의 식별값 대조");
        var source=draft?.Body??r.SourceProblem;
        if(ReactionMassCheck.NeedsQuantityReview(source))checks.Add(new("source-quantity","원본 용어 대조","fail","기준 문제에서 물질량/몰질량 판독 혼동이 의심됩니다. 질문을 임의로 바꾸지 말고 문제와 해설을 원본에 대조해야 합니다.","code"));
        if(!partialLearningStage)try{
            if(ReactionMassCheck.Solve(source) is not null&&ReactionMassCheck.Solve(r.Body) is null)checks.Add(new("source-reaction-type","원본 풀이 구조","fail","원본의 반응계수 b·상대 몰비 x·몰질량 질문이 다른 유형으로 바뀌었습니다. 원본 풀이와 같은 계산 구조로 다시 생성해야 합니다.","code"));
        }catch(InvalidDataException e){checks.Add(new("source-reaction-type","원본 풀이 구조","fail","원본 조건 검산 실패: "+e.Message,"code"));}
        try{
            ScientificVisuals.RequireVisuals(r);
            var options=new System.Text.Json.JsonSerializerOptions{PropertyNamingPolicy=System.Text.Json.JsonNamingPolicy.CamelCase};
            ScientificVisuals.ParseGraph(System.Text.Json.Nodes.JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(r.Graph,options)));
            ScientificVisuals.ParseDiagrams(System.Text.Json.Nodes.JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(r.Diagrams,options)));
            ScientificVisuals.ParseDrawings(System.Text.Json.Nodes.JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(r.Drawings,new System.Text.Json.JsonSerializerOptions{PropertyNamingPolicy=System.Text.Json.JsonNamingPolicy.CamelCase})));
            Add("visual-data","그림 데이터",true,"필수 그림·도형 좌표·라벨 형식 검사. 관계의 의미 검증은 별도");
        }catch(Exception e)when(e is InvalidDataException or InvalidOperationException){Add("visual-data","그림 데이터",false,e.Message);}
        if(!partialLearningStage){var reactionConditions=ReactionMassCheck.InspectMassConditions(r.Body);if(reactionConditions is not null)checks.Add(reactionConditions);}
        try{
            var solved=ReactionMassCheck.Solve(r.Body);
            if(solved is not null){var verified=ReactionMassCheck.Verify(r);Add("calculation","독립 수치 검산",Compact(verified.Answer)==Compact(r.Answer),"지원 반응량 유형의 코드 계산과 정답 대조");}
            else checks.Add(HeatingConcentrationCheck.Inspect(r)??new("calculation","독립 수치 검산","unknown","이 문항 유형의 독립 계산기는 아직 없습니다. AI 검토와 별개로 교사 검산이 필요합니다.","code"));
        }catch(Exception e)when(e is InvalidDataException or FormatException){Add("calculation","독립 수치 검산",false,e.Message);}
        foreach(var (id,label) in new[]{("language","문장·표현"),("conditions","조건·문제 성립"),("semantic-math","수치·단위·해설"),("visual-semantics","그림과 본문 관계")})checks.Add(new(id,label,"unknown","별도 AI 검토 대기","ai"));
        checks.Add(new("render","최종 PNG 대조","unknown","브라우저 렌더링 후 로컬 이미지 검토 대기","local-vision"));
        return new(QualityReport.CurrentVersion,checks.ToArray());
    }
    public static QualityReport Merge(QualityReport report,IEnumerable<QualityCheck> updates)
    {
        var map=updates.ToDictionary(c=>c.Id);var existing=report.Checks.Select(c=>c.Id).ToHashSet();return report with{Checks=report.Checks.Select(c=>map.GetValueOrDefault(c.Id,c)).Concat(map.Values.Where(c=>!existing.Contains(c.Id))).ToArray()};
    }
    public static QualityReport RefreshPartialStage(SampleResult result)
    {
        var fresh=Inspect(result,null,true);if(result.Quality is not { } old)return fresh;
        var code=fresh.Checks.Where(c=>c.Method.StartsWith("code",StringComparison.Ordinal)).ToArray();var ids=code.Select(c=>c.Id).ToHashSet();
        var preserved=old.Checks.Where(c=>c.Id=="input"||!c.Method.StartsWith("code",StringComparison.Ordinal))
            .Where(c=>c.Id is not("source-reaction-type" or "reaction-conditions")&&!ids.Contains(c.Id))
            .Select(c=>c.State=="skipped"?c with{State="unknown",Evidence=c.Id=="render"?"이 단계 문제의 PNG 대조가 아직 실행되지 않았습니다.":"단계별 검사 범위를 수정했습니다. 이 문항만 다시 검사해 주세요."}:c);
        return fresh with{Checks=code.Concat(preserved).ToArray(),RenderHash=old.RenderHash,RenderReviewVersion=old.RenderReviewVersion};
    }
    public static QualityReport MarkSkippedAfterFailure(QualityReport report)=>report.State!="fail"?report:report with{Checks=report.Checks.Select(c=>c.State=="unknown"?c with{State="skipped",Evidence="선행 검사에서 오류를 발견해 이 검사를 생략했습니다. 먼저 오류 항목을 수정해야 합니다."}:c).ToArray()};
}
