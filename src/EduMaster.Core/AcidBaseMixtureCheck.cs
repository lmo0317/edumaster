using System.Globalization;
using System.Text.RegularExpressions;

namespace EduMaster.Core;

// Explicitly supported H2X / Y(OH)2 / ZOH neutralization tables.  The model's
// explanation is never used as an input to the calculation.
public static class AcidBaseMixtureCheck
{
    private sealed record Table(double AcidConcentration,double[] AcidVolume,double[] BaseVolume,double[] MonoVolume,
        double RemainingConcentration,int AnionSign,int RatioLeft,int RatioRight,char Question,string[] Choices);
    private sealed record Candidate(double A,double B,double X,double AnionRatio,double CationsA,double CationsB,
        double AcidA,double HydroxideA,double AcidB,double HydroxideB,bool AcidicA,int ChoiceIndex,char Question,double Expected);

    public static bool IsFamily(string body)
    {
        var text=Plain(body);
        return text.Contains("H2X",StringComparison.OrdinalIgnoreCase)&&text.Contains("Y(OH)2",StringComparison.OrdinalIgnoreCase)
            &&text.Contains("혼합",StringComparison.Ordinal)&&text.Contains("몰 농도",StringComparison.Ordinal);
    }

    public static SolvedProblem? SolveSource(string body)
    {
        if(!IsFamily(body))return null;
        var solution=Solve(body,SourceChoices(body));
        var table=Read(body,SourceChoices(body));
        if(solution.ChoiceIndex<0)throw new InvalidDataException($"입력 문제의 계산값 {Fraction(solution.Expected)}이 보기와 일치하지 않습니다. 원본 표와 보기를 확인해 주세요.");
        var answer="①②③④⑤"[solution.ChoiceIndex]+" "+table.Choices[solution.ChoiceIndex];
        var gaVolume=table.AcidVolume[0]+table.BaseVolume[0]+table.MonoVolume[0];
        var steps=new List<string>{
            $"(가)의 H⁺ {Fraction(solution.AcidA)} mmol과 OH⁻ 2×a×{Fraction(table.BaseVolume[0])} mmol을 비교한다. 남은 H⁺ 또는 OH⁻ 농도 {Fraction(table.RemainingConcentration)} M과 전체 부피 {Fraction(gaVolume)} mL를 대입한다. 산성이라면 전하 균형상 X²⁻의 몰수보다 H⁺와 Y²⁺의 몰수 합이 커서 음이온/양이온 비가 1보다 작다. 주어진 이온 비 조건을 함께 적용하면 (가)는 {(solution.AcidicA?"산성":"염기성")}이고 a={Fraction(solution.A)} M이다. 실제 음이온/양이온 비는 {Fraction(solution.AnionRatio)}이다."
        };
        if(table.AcidVolume.Length>1){
            steps.Add($"(가)의 전체 양이온은 {Fraction(solution.CationsA)} mmol이다. (가):(나)의 양이온 몰수 비 {table.RatioLeft}:{table.RatioRight}로 (나)의 양이온은 {Fraction(solution.CationsB)} mmol이다. (나)의 Y²⁺는 a×{Fraction(table.BaseVolume[1])}={Fraction(solution.A*table.BaseVolume[1])} mmol, Z⁺는 b×{Fraction(table.MonoVolume[1])} mmol이므로 b={Fraction(solution.B)} M이다.");
            steps.Add($"(나)의 H⁺는 {Fraction(solution.AcidB)} mmol, 반응 전 OH⁻는 {Fraction(solution.HydroxideB)} mmol이다. 중화 후 남는 {(solution.HydroxideB>=solution.AcidB?"OH⁻":"H⁺")} {Fraction(Math.Abs(solution.HydroxideB-solution.AcidB))} mmol을 전체 부피 {Fraction(table.AcidVolume[1]+table.BaseVolume[1]+table.MonoVolume[1])} mL로 나누면 x={Fraction(solution.X)} M이다. 물음의 {solution.Question}={Fraction(solution.Expected)}이 보기 {"①②③④⑤"[solution.ChoiceIndex]}와 일치한다.");
        }
        var detail=string.Join("\n",steps.Select((step,index)=>$"STEP {index+1}. {step}"));
        return new(answer,detail,steps.ToArray(),"코드 독립 검산 · 이온 수 및 전하 균형");
    }

    public static QualityCheck? Inspect(SampleResult result)
    {
        if(!IsFamily(result.Body))return null;
        try{
            var solution=Solve(result.Body,result.Choices);
            var selected=result.Answer.Length>0?"①②③④⑤".IndexOf(result.Answer.Trim()[0]):-1;
            var correct=solution.ChoiceIndex>=0&&selected==solution.ChoiceIndex;
            var conflict=ContradictsIonCondition(result.Body,result.Explanation)||ContradictsValues(result.Explanation,solution);
            var state=correct&&!conflict?"pass":"fail";
            var evidence=solution.ChoiceIndex<0
                ?$"이온 수·전하 균형 계산값 {solution.Question}={Fraction(solution.Expected)}이 보기 5개 중 어디에도 없습니다."
                :conflict?$"(가)의 음이온/양이온 비 조건과 해설의 산성·염기성 판단이 모순됩니다. 계산 비율 {Fraction(solution.AnionRatio)}."
                :$"이온 수·전하 균형으로 a={Fraction(solution.A)}, b={Fraction(solution.B)}, x={Fraction(solution.X)}. 이 문항의 {solution.Question}={Fraction(solution.Expected)}, 정답 {"①②③④⑤"[solution.ChoiceIndex]}.";
            if(!correct&&solution.ChoiceIndex>=0)evidence+=$" 표시된 정답 {result.Answer}이 계산 결과와 다릅니다.";
            return new("calculation","독립 수치 검산",state,evidence,"code-acid-base");
        }catch(InvalidDataException error){return new("calculation","독립 수치 검산","fail",error.Message,"code-acid-base");}
    }

    public static QualityCheck? InspectSource(SampleResult result)
    {
        if(!IsFamily(result.SourceProblem))return null;
        try{
            var solution=Solve(result.SourceProblem,SourceChoices(result.SourceProblem));
            var selected=result.SourceAnswer.Length>0?"①②③④⑤".IndexOf(result.SourceAnswer.Trim()[0]):-1;
            var correct=solution.ChoiceIndex>=0&&(string.IsNullOrWhiteSpace(result.SourceAnswer)||selected==solution.ChoiceIndex);
            var conflict=ContradictsIonCondition(result.SourceProblem,result.SourceExplanation)||ContradictsValues(result.SourceExplanation,solution);
            return new("source-calculation","입력 문제 풀이 검산",correct&&!conflict?"pass":"fail",
                correct&&!conflict?$"입력 문제를 독립 계산해 {solution.Question}={Fraction(solution.Expected)}, 정답 {"①②③④⑤"[solution.ChoiceIndex]}와 대조했습니다.":
                $"입력 해설의 정답 또는 산성·염기성 판단이 원본 조건과 모순됩니다. 코드 계산: {solution.Question}={Fraction(solution.Expected)}, 정답 {(solution.ChoiceIndex>=0?"①②③④⑤"[solution.ChoiceIndex].ToString():"보기 없음")}. 현재 입력 정답: {result.SourceAnswer}.","code-acid-base");
        }catch(InvalidDataException error){return new("source-calculation","입력 문제 풀이 검산","fail",error.Message,"code-acid-base");}
    }

    public static QualityCheck? InspectOriginality(SampleResult result)
    {
        if(!IsFamily(result.SourceProblem)||!IsFamily(result.Body))return null;
        try{
            var source=Read(result.SourceProblem,SourceChoices(result.SourceProblem));
            var variant=Read(result.Body,result.Choices);
            var same=Near(source.AcidConcentration,variant.AcidConcentration)
                &&source.AcidVolume.SequenceEqual(variant.AcidVolume)&&source.BaseVolume.SequenceEqual(variant.BaseVolume)
                &&source.MonoVolume.SequenceEqual(variant.MonoVolume)&&Near(source.RemainingConcentration,variant.RemainingConcentration)
                &&source.AnionSign==variant.AnionSign&&source.RatioLeft==variant.RatioLeft&&source.RatioRight==variant.RatioRight
                &&source.Question==variant.Question&&source.Choices.SequenceEqual(variant.Choices);
            return new("source-originality","쌍둥이 문제 변형 여부",same?"fail":"pass",
                same?"원본의 농도·부피·이온 비·질문·보기까지 같아 새 쌍둥이 문제가 아닙니다.":"원본과 생성 문제의 수치 또는 질문이 다릅니다.","code-acid-base");
        }catch(InvalidDataException){return null;}
    }

    private static Candidate Solve(string body,string[] choices)
    {
        var table=Read(body,choices);
        var volumeA=table.AcidVolume[0]+table.BaseVolume[0]+table.MonoVolume[0];
        if(table.MonoVolume[0]!=0)throw new InvalidDataException("(가)에 ZOH가 포함된 이온 혼합 문제는 아직 코드 검산 범위 밖입니다.");
        var acidA=2*table.AcidConcentration*table.AcidVolume[0];
        var candidates=new List<Candidate>();
        foreach(var acidic in new[]{true,false}){
            var a=(acidA+(acidic?-1:1)*table.RemainingConcentration*volumeA)/(2*table.BaseVolume[0]);
            if(a<=0||!double.IsFinite(a))continue;
            var hydroxideA=2*a*table.BaseVolume[0];
            var remainingH=Math.Max(0,acidA-hydroxideA);var remainingOH=Math.Max(0,hydroxideA-acidA);
            if(acidic!= (remainingH>1e-8))continue;
            var anions=table.AcidConcentration*table.AcidVolume[0]+remainingOH;
            var cations=a*table.BaseVolume[0]+remainingH;
            var ratio=anions/cations;
            if(table.AnionSign>0&&ratio<=1+1e-8||table.AnionSign<0&&ratio>=1-1e-8)continue;
            if(acidic&&Regex.IsMatch(Plain(body),@"\(가\).{0,18}OH-가\s*남",RegexOptions.Singleline))continue;
            if(!acidic&&Regex.IsMatch(Plain(body),@"\(가\).{0,18}H\+가\s*남",RegexOptions.Singleline))continue;
            double b=0,x=0,cationsB=0,acidB=0,hydroxideB=0;
            if(table.AcidVolume.Length>1){
                if(table.RatioLeft<=0||table.MonoVolume[1]<=0)throw new InvalidDataException("(가):(나) 양이온 몰수 비 또는 ZOH 부피가 없어 b를 구할 수 없습니다.");
                cationsB=cations*table.RatioRight/table.RatioLeft;
                b=(cationsB-a*table.BaseVolume[1])/table.MonoVolume[1];
                if(b<=0||!double.IsFinite(b))continue;
                acidB=2*table.AcidConcentration*table.AcidVolume[1];
                hydroxideB=2*a*table.BaseVolume[1]+b*table.MonoVolume[1];
                if(hydroxideB+1e-8<acidB)continue; // This branch's cation equation assumes no remaining H+.
                x=Math.Abs(hydroxideB-acidB)/(table.AcidVolume[1]+table.BaseVolume[1]+table.MonoVolume[1]);
            }
            var expected=table.Question switch{'a'=>a,'b'=>b,'x'=>x,_=>double.NaN};
            var matching=table.Choices.Select((choice,index)=>(Value:ChoiceValue(choice),Index:index)).Where(v=>v.Value is not null&&Near(v.Value.Value,expected)).Select(v=>v.Index).ToArray();
            candidates.Add(new(a,b,x,ratio,cations,cationsB,acidA,hydroxideA,acidB,hydroxideB,acidic,matching.Length==1?matching[0]:-1,table.Question,expected));
        }
        if(candidates.Count!=1)throw new InvalidDataException(candidates.Count==0?"(가)의 잔류 이온 농도와 음이온/양이온 비를 동시에 만족하는 양의 농도가 없습니다.":"산성·염기성 두 경우가 모두 남아 정답이 유일하지 않습니다.");
        return candidates[0];
    }

    private static Table Read(string body,string[] choices)
    {
        var text=Plain(body);var lines=text.Split('\n');
        double[]? acid=null,baseVolume=null,mono=null;double acidConcentration=0;
        foreach(var line in lines.Where(line=>line.Contains('|'))){
            foreach(var (pattern,kind) in new[]{(@"(?<c>\d+(?:\.\d+)?)\s*M\s*H2X","acid"),(@"(?<c>a|\d+(?:\.\d+)?)\s*M\s*Y\(OH\)2","base"),(@"(?<c>b|\d+(?:\.\d+)?)\s*M\s*ZOH","mono")}){
                var match=Regex.Match(line,pattern,RegexOptions.IgnoreCase);if(!match.Success)continue;
                var tail=line[(match.Index+match.Length)..];var values=Regex.Matches(tail,@"(?<![\w.])\d+(?:\.\d+)?(?![\w.])").Select(m=>Number(m.Value)).ToArray();
                if(values.Length is <1 or >2)throw new InvalidDataException("이온 혼합 표의 부피 열을 해석하지 못했습니다.");
                if(kind=="acid"){acid=values;acidConcentration=Number(match.Groups["c"].Value);}
                else if(kind=="base")baseVolume=values;else mono=values;
            }
        }
        if(acid is null||baseVolume is null||acid.Length!=baseVolume.Length||acid.Length is <1 or >2)
            throw new InvalidDataException("H₂X·Y(OH)₂ 혼합 표의 농도와 부피를 코드로 읽지 못했습니다.");
        mono??=new double[acid.Length];if(mono.Length!=acid.Length)throw new InvalidDataException("ZOH 부피 열이 다른 실험과 맞지 않습니다.");
        var concentrationLine=lines.FirstOrDefault(line=>line.Contains('|')&&line.Contains("몰 농도")&&(line.Contains("H+")||line.Contains("OH-")));
        if(concentrationLine is null)throw new InvalidDataException("(가)의 남은 H⁺ 또는 OH⁻ 농도가 표에 없습니다.");
        var firstCell=concentrationLine.Split('|',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries).Skip(1).FirstOrDefault()??"";
        var remaining=ChoiceValue(firstCell)??throw new InvalidDataException("(가)의 남은 H⁺ 또는 OH⁻ 농도를 읽지 못했습니다.");
        var anionSign=Regex.IsMatch(text,@"음이온[^\n]{0,90}양이온[^\n]{0,30}>\s*1")?1:Regex.IsMatch(text,@"음이온[^\n]{0,90}양이온[^\n]{0,30}<\s*1")?-1:0;
        var ratioMatch=Regex.Match(text,@"양이온[^\n]{0,80}\(가\)\s*:\s*\(나\)\s*=\s*(\d+)\s*:\s*(\d+)");
        var question=Regex.Match(text,@"(?m)^\s*([abx])\s*는\s*\?").Groups[1].Value.FirstOrDefault();
        if(question is not('a' or 'b' or 'x'))throw new InvalidDataException("이온 혼합 문제에서 구하는 a·b·x를 확인하지 못했습니다.");
        if(acid.Length==2&&!ratioMatch.Success)throw new InvalidDataException("(가):(나) 양이온 몰수 비가 없습니다.");
        if(acid.Length==1&&anionSign==0&&!Regex.IsMatch(text,@"\(가\)[^\n]{0,45}(H\+|OH-)가\s*남"))throw new InvalidDataException("(가)에 남는 이온의 종류를 결정할 조건이 없습니다.");
        return new(acidConcentration,acid,baseVolume,mono,remaining,anionSign,ratioMatch.Success?int.Parse(ratioMatch.Groups[1].Value):0,ratioMatch.Success?int.Parse(ratioMatch.Groups[2].Value):0,question,choices);
    }

    private static bool ContradictsIonCondition(string body,string explanation)
    {
        var text=Plain(body);var answer=Plain(explanation);
        var greater=Regex.IsMatch(text,@"음이온[^\n]{0,90}양이온[^\n]{0,30}>\s*1");
        return greater&&Regex.IsMatch(answer,@"(?:따라서|그러므로|결론적으로|즉)\s*\(가\)[^.\n]{0,35}H\+가\s*남|\(가\)(?:는|에서)\s*산성(?:이다|이므로)");
    }
    private static bool ContradictsValues(string explanation,Candidate solution)
    {
        var plain=Plain(explanation);
        foreach(var (variable,expected) in new[]{('a',solution.A),('b',solution.B),('x',solution.X)}){
            if(variable is 'b' or 'x'&&solution.CationsB==0)continue;
            var matches=Regex.Matches(plain,$@"(?<![\w]){variable}\s*=\s*(\d+(?:\.\d+)?(?:\s*/\s*\d+(?:\.\d+)?)?)",RegexOptions.IgnoreCase);
            if(matches.Count>0&&ChoiceValue(matches[^1].Groups[1].Value) is { } stated&&!Near(stated,expected))return true;
        }
        return false;
    }
    private static string[] SourceChoices(string body)=>Regex.Matches(Plain(body),@"[①②③④⑤]\s*(\d+(?:\.\d+)?(?:\s*/\s*\d+)?(?:\s*M)?)").Select(m=>m.Groups[1].Value.Trim()).ToArray();
    private static string Plain(string text)=>LocalVisionReader.NormalizeMath(text).Replace('₀','0').Replace('₁','1').Replace('₂','2').Replace('₃','3').Replace('₄','4').Replace('₅','5').Replace('₆','6').Replace('⁺','+').Replace('⁻','-').Replace('−','-');
    private static double Number(string text)=>double.Parse(text,CultureInfo.InvariantCulture);
    private static double? ChoiceValue(string text){var match=Regex.Match(Plain(text),@"(?<!\d)(\d+(?:\.\d+)?)(?:\s*/\s*(\d+(?:\.\d+)?))?");return match.Success?Number(match.Groups[1].Value)/(match.Groups[2].Success?Number(match.Groups[2].Value):1):null;}
    private static bool Near(double a,double b)=>Math.Abs(a-b)<1e-6*Math.Max(1,Math.Abs(b));
    private static string Fraction(double value){foreach(var denominator in Enumerable.Range(1,60)){var numerator=Math.Round(value*denominator);if(Math.Abs(value-numerator/denominator)<1e-8)return denominator==1?numerator.ToString(CultureInfo.InvariantCulture):$"{numerator}/{denominator}";}return value.ToString("0.####",CultureInfo.InvariantCulture);}
}
