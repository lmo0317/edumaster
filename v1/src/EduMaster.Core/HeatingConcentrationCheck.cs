using System.Globalization;
using System.Text.RegularExpressions;
namespace EduMaster.Core;

// Narrow, explicit support: aqueous NaOH heating with no evaporation and densities d1/d2.
public static class HeatingConcentrationCheck
{
    public static QualityCheck? Inspect(SampleResult r)
    {
        var body=Plain(r.Body);
        if(!body.Contains("NaOH")||!body.Contains("가열")||!body.Contains("몰랄")||!body.Contains("몰농도")||!Regex.IsMatch(body,@"증발.{0,8}무시")||Regex.IsMatch(body,@"첨가|혼합|섞|추가|넣어|넣었|반응"))return null;
        var cMatch=Regex.Match(body,@"(?<c>\d+(?:\.\d+)?)\s*M\s*NaOH");var massMatch=Regex.Match(body,@"몰질량.{0,6}?(?<m>\d+(?:\.\d+)?)\s*g/mol");
        if(!cMatch.Success||!massMatch.Success)return null;
        var c=double.Parse(cMatch.Groups["c"].Value,CultureInfo.InvariantCulture);var mass=double.Parse(massMatch.Groups["m"].Value,CultureInfo.InvariantCulture);
        if(c<=0||Math.Abs(mass-40)>1e-9)return null;
        if(!body.Contains("d1")||!body.Contains("d2"))return Numeric(r,body,c);
        try{
            var matches=new List<int>();
            for(var i=0;i<r.Choices.Length;i++){
                var parts=Regex.Split(Regex.Replace(Plain(r.Choices[i]),@"^[①②③④⑤]\s*",""),@"\s*[,;；]\s*");if(parts.Length!=2)return null;
                bool valid=true;
                foreach(var shift in new[]{.7,.9,1.1,1.4,1.8}){
                    var d1=c*mass/1000+shift;var d2=d1*.95;
                    var expectedC=c*d2/d1;var expectedM=1000*c/(1000*d1-c*mass);
                    valid&=Near(new Expression(parts[0],d1,d2).Read(),expectedC)&&Near(new Expression(parts[1],d1,d2).Read(),expectedM);
                }
                if(valid)matches.Add(i);
            }
            var selected=r.Answer.Length>0?"①②③④⑤".IndexOf(r.Answer.Trim()[0]):-1;
            return new("calculation","독립 수치 검산",matches.Count==1&&selected==matches[0]?"pass":"fail",$"NaOH 가열·증발 무시 유형: 몰농도 C₀d₂/d₁, 몰랄 농도 1000C₀/(1000d₁−40C₀). 서로 다른 밀도 5쌍으로 식을 대조했습니다. 일치 보기: {string.Join(",",matches.Select(i=>i+1))}","code");
        }catch(FormatException){return null;}
    }
    private static bool Near(double a,double b)=>double.IsFinite(a)&&Math.Abs(a-b)<1e-7*Math.Max(1,Math.Abs(b));
    private static QualityCheck? Numeric(SampleResult r,string body,double c)
    {
        var first=Regex.Match(body,@"\(가\)의?\s*밀도.{0,4}?(?<d>\d+(?:\.\d+)?)\s*g/mL");var second=Regex.Match(body,@"\(나\)의?\s*밀도.{0,4}?(?<d>\d+(?:\.\d+)?)\s*g/mL");
        if(!first.Success||!second.Success)return null;
        var d1=double.Parse(first.Groups["d"].Value,CultureInfo.InvariantCulture);var d2=double.Parse(second.Groups["d"].Value,CultureInfo.InvariantCulture);
        if(d1<=0||d2<=0||1000*d1<=40*c)return new("calculation","독립 수치 검산","fail","밀도 또는 용매 질량이 양수가 아닙니다.","code");
        var expectedC=c*d2/d1;var expectedM=1000*c/(1000*d1-40*c);var matches=new List<int>();
        for(var i=0;i<r.Choices.Length;i++){
            var match=Regex.Match(r.Choices[i],@"^\s*(?<c>\d+(?:\.\d+)?)\s*M\s*[,;]\s*(?<m>\d+(?:\.\d+)?)\s*m\s*$");if(!match.Success)return null;
            bool Rounded(string value,double expected){var parsed=double.Parse(value,CultureInfo.InvariantCulture);var places=value.Contains('.')?value.Length-value.IndexOf('.')-1:0;return Math.Abs(parsed-expected)<=.5*Math.Pow(10,-places)+1e-9;}
            if(Rounded(match.Groups["c"].Value,expectedC)&&Rounded(match.Groups["m"].Value,expectedM))matches.Add(i);
        }
        var selected=r.Answer.Length>0?"①②③④⑤".IndexOf(r.Answer.Trim()[0]):-1;
        return new("calculation","독립 수치 검산",matches.Count==1&&matches[0]==selected?"pass":"fail",FormattableString.Invariant($"NaOH 가열·증발 무시: 몰농도 {expectedC:G8} M, 몰랄 농도 {expectedM:G8} mol/kg. 보기의 표시 소수 자릿수로 반올림 오차와 정답 유일성을 대조했습니다."),"code");
    }
    private static string Plain(string s)=>s.Replace('₁','1').Replace('₂','2').Replace('−','-').Replace('×','*').Replace('÷','/');
    private sealed class Expression(string source,double d1,double d2)
    {
        private readonly string text=Regex.Replace(source,@"\s+","");private int at;
        public double Read(){var v=Sum();if(at!=text.Length)throw new FormatException();return v;}
        private double Sum(){var v=Product();while(at<text.Length&&text[at] is '+' or '-'){var op=text[at++];var n=Product();v=op=='+'?v+n:v-n;}return v;}
        private double Product(){var v=Atom();while(at<text.Length){var c=text[at];if(c is '*' or '/'){at++;var n=Atom();v=c=='*'?v*n:v/n;}else if(c=='('||c=='d'||char.IsDigit(c)){v*=Atom();}else break;}return v;}
        private double Atom(){if(at>=text.Length)throw new FormatException();if(text[at] is '+' or '-'){var sign=text[at++];return(sign=='-'?-1:1)*Atom();}if(text[at]=='('){at++;var n=Sum();if(at>=text.Length||text[at++]!=')')throw new FormatException();return n;}if(text[at..].StartsWith("d1")){at+=2;return d1;}if(text[at..].StartsWith("d2")){at+=2;return d2;}var start=at;while(at<text.Length&&(char.IsDigit(text[at])||text[at]=='.'))at++;if(at==start)throw new FormatException();return double.Parse(text[start..at],CultureInfo.InvariantCulture);}
    }
}
